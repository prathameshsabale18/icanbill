import React, { useEffect, useRef, useState } from 'react';
import { getDeviceSessionIds, localData } from '../localDataClient';
import { supabase } from '../supabaseClient';

async function establishAccountAccess(userId, deviceId, replaceOldestDevice) {
  const { error: organizationError } = await supabase.rpc('ensure_current_organization');
  if (organizationError) throw new Error(organizationError.message);

  const { error: claimError } = await supabase.rpc('claim_auth_session', {
    p_device_id: deviceId,
    p_replace_oldest: replaceOldestDevice,
  });
  if (claimError) throw new Error(claimError.message);

  const { data: subscription, error: statusError } = await supabase.rpc('get_subscription_status', {
    p_device_id: deviceId,
  });
  if (statusError) throw new Error(statusError.message);

  const migration = await localData.migrateLegacyData(userId);
  return { subscription, migration };
}

function getSessionIdentity(session) {
  if (!session?.user?.id) return null;
  const tokenPayload = session.access_token?.split('.')[1];
  if (!tokenPayload) return `${session.user.id}:unknown`;

  try {
    const base64 = tokenPayload.replace(/-/g, '+').replace(/_/g, '/');
    const paddedBase64 = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
    const claims = JSON.parse(globalThis.atob(paddedBase64));
    return `${session.user.id}:${claims.session_id || tokenPayload}`;
  } catch {
    return `${session.user.id}:${tokenPayload}`;
  }
}

export default function AuthGate({ children }) {
  const [session, setSession] = useState(null);
  const [sessionIdentity, setSessionIdentity] = useState(null);
  const [loading, setLoading] = useState(true);
  const [accessLoading, setAccessLoading] = useState(false);
  const [accessError, setAccessError] = useState('');
  const [deviceLimitReached, setDeviceLimitReached] = useState(false);
  const [accessAttempt, setAccessAttempt] = useState(0);
  const [subscription, setSubscription] = useState(null);
  const [mode, setMode] = useState('sign-in');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [activationCode, setActivationCode] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const replaceOldestDeviceRef = useRef(false);
  const sessionIdentityRef = useRef(null);
  const sessionUserId = session?.user?.id;

  useEffect(() => {
    let mounted = true;
    supabase.auth.getSession().then(({ data, error: sessionError }) => {
      if (!mounted) return;
      if (sessionError) setError(sessionError.message);
      const identity = getSessionIdentity(data.session);
      sessionIdentityRef.current = identity;
      setSessionIdentity(identity);
      setSession(data.session);
      setAccessLoading(Boolean(data.session));
      setLoading(false);
    }).catch(sessionError => {
      if (!mounted) return;
      setError(sessionError.message);
      setAccessLoading(false);
      setLoading(false);
    });

    const { data } = supabase.auth.onAuthStateChange((event, nextSession) => {
      if (event === 'INITIAL_SESSION' || event === 'TOKEN_REFRESHED') return;
      const nextIdentity = getSessionIdentity(nextSession);
      const identityChanged = nextIdentity !== sessionIdentityRef.current;
      sessionIdentityRef.current = nextIdentity;
      setSession(nextSession);
      if (!identityChanged) return;
      setSessionIdentity(nextIdentity);
      setAccessLoading(Boolean(nextSession));
      setAccessError('');
      setDeviceLimitReached(false);
      replaceOldestDeviceRef.current = false;
      setSubscription(null);
    });
    return () => {
      mounted = false;
      data.subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!sessionUserId || !sessionIdentity) return undefined;

    let mounted = true;
    let heartbeat;
    let deviceId;
    const replaceOldestDevice = replaceOldestDeviceRef.current;
    replaceOldestDeviceRef.current = false;

    const activateSession = async () => {
      if (!mounted) return;
      deviceId = getDeviceSessionIds().deviceId;
      const { subscription: currentSubscription, migration } = await establishAccountAccess(
        sessionUserId,
        deviceId,
        replaceOldestDevice
      );
      if (!mounted) return;
      setSubscription(currentSubscription);
      setDeviceLimitReached(false);
      const accessNotice = replaceOldestDevice
        ? 'The least recently used registered browser profile was replaced.'
        : '';
      setNotice([accessNotice, migration.warning].filter(Boolean).join(' '));

      heartbeat = window.setInterval(async () => {
        try {
          const { data, error: statusError } = await supabase.rpc('get_subscription_status', {
            p_device_id: deviceId,
          });
          if (statusError) throw new Error(statusError.message);
          if (mounted) setSubscription(data);
        } catch (heartbeatError) {
          if (mounted) {
            setAccessError(heartbeatError.message);
            setSubscription(null);
          }
        }
      }, 30000);
    };

    activateSession().then(() => {
      if (mounted) setAccessLoading(false);
    }).catch(accessSetupError => {
      if (mounted) {
        if (accessSetupError.message.includes('DEVICE_LIMIT_REACHED')) {
          setDeviceLimitReached(true);
          setAccessError('');
        } else {
          setAccessError(accessSetupError.message);
        }
        setAccessLoading(false);
      }
    });

    return () => {
      mounted = false;
      if (heartbeat) window.clearInterval(heartbeat);
    };
  }, [sessionIdentity, sessionUserId, accessAttempt]);

  const submit = async event => {
    event.preventDefault();
    setError('');
    setNotice('');
    setSubmitting(true);

    try {
      if (mode === 'sign-in') {
        const { error: signInError } = await supabase.auth.signInWithPassword({
          email: email.trim(),
          password,
        });
        if (signInError) throw signInError;
        return;
      }

      if (!activationCode.trim()) {
        throw new Error('invalid activation key');
      }
      const { error: signUpError } = await supabase.auth.signUp({
        email: email.trim(),
        password,
        options: {
          data: { activation_code: activationCode.trim() },
        },
      });
      if (signUpError) {
        const isInvalidActivationKey = signUpError.message === 'Database error saving new user'
          || /activation code/i.test(signUpError.message);
        throw new Error(isInvalidActivationKey ? 'invalid activation key' : signUpError.message);
      }
      setMode('sign-in');
      setPassword('');
      setActivationCode('');
      setNotice('Account created. Check your email to confirm your account, then sign in.');
    } catch (submitError) {
      setError(submitError.message);
    } finally {
      setSubmitting(false);
    }
  };

  const replaceOldestDevice = () => {
    replaceOldestDeviceRef.current = true;
    setDeviceLimitReached(false);
    setAccessLoading(true);
    setAccessAttempt(attempt => attempt + 1);
  };

  const redeemCode = async event => {
    event.preventDefault();
    setError('');
    setNotice('');
    setSubmitting(true);
    try {
      const { deviceId } = getDeviceSessionIds();
      const { data, error: redeemError } = await supabase.rpc('redeem_subscription_code', {
        p_code: activationCode.trim(),
        p_device_id: deviceId,
      });
      if (redeemError) throw redeemError;
      const migration = await localData.migrateLegacyData(session.user.id);
      setSubscription({
        active: true,
        ends_at: data.ends_at,
        days_remaining: Math.ceil((new Date(data.ends_at).getTime() - Date.now()) / 86400000),
        expiry_reminder_due: false,
      });
      setActivationCode('');
      setNotice(migration.warning || 'Subscription renewed for 30 days.');
    } catch (redeemError) {
      setError(redeemError.message);
    } finally {
      setSubmitting(false);
    }
  };

  const signOut = async () => {
    const { error: signOutError } = await supabase.auth.signOut({ scope: 'local' });
    if (signOutError) setAccessError(signOutError.message);
  };

  if (loading || (session && accessLoading)) {
    return (
      <div style={pageStyle}>
        <div style={cardStyle}>Opening iCanBill securely…</div>
      </div>
    );
  }

  if (session && deviceLimitReached) {
    return (
      <div style={pageStyle}>
        <div style={cardStyle}>
          <div style={brandStyle}>ICANBILL</div>
          <h1 style={headingStyle}>Device limit reached</h1>
          <p style={descriptionStyle}>
            This subscription already has two registered browser profiles. You can replace the
            least recently used profile with this one.
          </p>
          <button type="button" onClick={replaceOldestDevice} style={primaryButton}>
            Replace oldest device and continue
          </button>
          <button type="button" onClick={signOut} style={secondaryButton}>Sign out</button>
        </div>
      </div>
    );
  }

  if (!session) {
    return (
      <div style={pageStyle}>
        <form onSubmit={submit} style={cardStyle}>
          <div style={brandStyle}>ICANBILL</div>
          <h1 style={headingStyle}>
            {mode === 'sign-in' ? 'Sign in to your workspace' : 'Activate your account'}
          </h1>
          <p style={descriptionStyle}>
            {mode === 'sign-in'
              ? 'Sign in with the email address used when your subscription was activated.'
              : 'Create your password after payment using the activation code we provided.'}
          </p>
          {mode === 'sign-up' && (
            <label style={fieldStyle}>
              Paid activation code
              <input
                required
                value={activationCode}
                onChange={event => setActivationCode(event.target.value)}
                style={inputStyle}
                autoComplete="one-time-code"
              />
            </label>
          )}
          <label style={fieldStyle}>
            Email
            <input
              required
              type="email"
              value={email}
              onChange={event => setEmail(event.target.value)}
              style={inputStyle}
              autoComplete="email"
            />
          </label>
          <label style={fieldStyle}>
            Password
            <input
              required
              type="password"
              minLength={8}
              value={password}
              onChange={event => setPassword(event.target.value)}
              style={inputStyle}
              autoComplete={mode === 'sign-in' ? 'current-password' : 'new-password'}
            />
          </label>
          {error && <div role="alert" style={errorStyle}>{error}</div>}
          {notice && <div role="status" style={noticeStyle}>{notice}</div>}
          <button type="submit" disabled={submitting} style={primaryButton}>
            {submitting ? 'Please wait…' : mode === 'sign-in' ? 'Sign in' : 'Activate and create password'}
          </button>
          <button
            type="button"
            onClick={() => {
              setError('');
              setNotice('');
              setMode(mode === 'sign-in' ? 'sign-up' : 'sign-in');
            }}
            style={secondaryButton}
          >
            {mode === 'sign-in' ? 'Have a paid activation code? Create your account' : 'Already activated? Sign in'}
          </button>
        </form>
      </div>
    );
  }

  if (accessError) {
    return (
      <AccessMessage
        title="This account is not available in this session"
        message={accessError}
        onSignOut={signOut}
      />
    );
  }

  if (!subscription?.active) {
    return (
      <div style={pageStyle}>
        <form onSubmit={redeemCode} style={cardStyle}>
          <div style={brandStyle}>ICANBILL</div>
          <h1 style={headingStyle}>Subscription ended</h1>
          <p style={descriptionStyle}>
            Your workspace is locked. Renew for 30 days with a new activation code issued after payment.
          </p>
          <label style={fieldStyle}>
            Renewal code
            <input
              required
              value={activationCode}
              onChange={event => setActivationCode(event.target.value)}
              style={inputStyle}
              autoComplete="one-time-code"
            />
          </label>
          {error && <div role="alert" style={errorStyle}>{error}</div>}
          {notice && <div role="status" style={noticeStyle}>{notice}</div>}
          <button type="submit" disabled={submitting} style={primaryButton}>
            {submitting ? 'Please wait…' : 'Renew for 30 days'}
          </button>
          <button type="button" onClick={signOut} style={secondaryButton}>Sign out</button>
        </form>
      </div>
    );
  }

  return (
    <>
      {subscription.expiry_reminder_due && (
        <div role="status" style={reminderStyle}>
          Your subscription ends in {subscription.days_remaining} day{subscription.days_remaining === 1 ? '' : 's'}.
          Renew now to keep using iCanBill without interruption.
        </div>
      )}
      {notice && <div role="status" style={noticeStyle}>{notice}</div>}
      {children}
    </>
  );
}

function AccessMessage({ title, message, onSignOut }) {
  return (
    <div style={pageStyle}>
      <div style={cardStyle}>
        <div style={brandStyle}>ICANBILL</div>
        <h1 style={headingStyle}>{title}</h1>
        <div role="alert" style={errorStyle}>{message}</div>
        <button type="button" onClick={onSignOut} style={primaryButton}>Sign out</button>
      </div>
    </div>
  );
}

const pageStyle = {
  minHeight: '100vh',
  display: 'grid',
  placeItems: 'center',
  padding: '20px',
  background: 'linear-gradient(135deg, #edf7f5, #f7f9fc)',
};
const cardStyle = {
  width: 'min(430px, 100%)',
  padding: '28px',
  border: '1px solid #e3e9ef',
  borderRadius: '16px',
  background: '#fff',
  boxShadow: '0 24px 70px rgba(34, 52, 65, .12)',
};
const brandStyle = {
  color: '#087d73',
  fontSize: '11px',
  fontWeight: 800,
  letterSpacing: '1px',
};
const headingStyle = {
  margin: '8px 0 6px',
  fontSize: '25px',
  color: '#172033',
};
const descriptionStyle = {
  margin: '0 0 18px',
  color: '#687486',
  fontSize: '13px',
  lineHeight: 1.5,
};
const fieldStyle = {
  display: 'grid',
  gap: '7px',
  color: '#475569',
  fontSize: '12px',
  fontWeight: 700,
  marginBottom: '12px',
};
const inputStyle = {
  width: '100%',
  height: '44px',
  border: '1px solid #d9e2e8',
  borderRadius: '8px',
  padding: '0 12px',
  fontSize: '14px',
};
const primaryButton = {
  width: '100%',
  height: '44px',
  border: 0,
  borderRadius: '8px',
  background: '#087d73',
  color: '#fff',
  fontWeight: 800,
  cursor: 'pointer',
};
const secondaryButton = {
  width: '100%',
  marginTop: '10px',
  border: 0,
  background: 'transparent',
  color: '#087d73',
  fontSize: '12px',
  cursor: 'pointer',
};
const errorStyle = {
  marginBottom: '12px',
  padding: '10px',
  borderRadius: '8px',
  background: '#fef2f2',
  color: '#b91c1c',
  fontSize: '12px',
};
const noticeStyle = {
  marginBottom: '12px',
  padding: '10px',
  borderRadius: '8px',
  background: '#ecfdf5',
  color: '#047857',
  fontSize: '12px',
};
const reminderStyle = {
  padding: '10px 20px',
  background: '#fff7df',
  color: '#805b00',
  fontSize: '13px',
  fontWeight: 700,
  textAlign: 'center',
};
