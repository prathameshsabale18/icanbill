import React, { useEffect, useState } from 'react';
import { supabase } from '../supabaseClient';

export default function AuthGate({ children }) {
  const [session, setSession] = useState(null);
  const [loading, setLoading] = useState(true);
  const [mode, setMode] = useState('sign-in');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => {
    let mounted = true;
    supabase.auth.getSession().then(({ data }) => {
      if (mounted) {
        setSession(data.session);
        setLoading(false);
        if (data.session) {
          supabase.rpc('ensure_current_organization').then(({ error: orgError }) => {
            if (orgError) setError(orgError.message);
          });
        }
      }
    });
    const { data } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
      if (nextSession) {
        supabase.rpc('ensure_current_organization').then(({ error: orgError }) => {
          if (orgError) setError(orgError.message);
        });
      }
    });
    return () => {
      mounted = false;
      data.subscription.unsubscribe();
    };
  }, []);

  const submit = async event => {
    event.preventDefault();
    setError('');
    setNotice('');

    if (mode === 'sign-in') {
      const { error: signInError } = await supabase.auth.signInWithPassword({
        email,
        password,
      });
      if (signInError) setError(signInError.message);
      return;
    }

    const { error: signUpError } = await supabase.auth.signUp({
      email,
      password,
    });
    if (signUpError) {
      setError(signUpError.message);
    } else {
      setNotice('Check your email to confirm your account.');
    }
  };

  if (loading) {
    return (
      <div style={pageStyle}>
        <div style={cardStyle}>Opening iCanBill…</div>
      </div>
    );
  }

  if (!session) {
    return (
      <div style={pageStyle}>
        <form onSubmit={submit} style={cardStyle}>
          <div style={{ color: '#087d73', fontSize: '11px', fontWeight: 800, letterSpacing: '1px' }}>
            ICANBILL
          </div>
          <h1 style={{ margin: '8px 0 6px', fontSize: '25px', color: '#172033' }}>
            {mode === 'sign-in' ? 'Sign in to your workspace' : 'Create your workspace account'}
          </h1>
          <p style={{ margin: '0 0 18px', color: '#687486', fontSize: '13px' }}>
            Secure access for billing data and your organization.
          </p>
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
          <button type="submit" style={primaryButton}>
            {mode === 'sign-in' ? 'Sign in' : 'Create account'}
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
            {mode === 'sign-in' ? 'New to iCanBill? Create an account' : 'Already have an account? Sign in'}
          </button>
        </form>
      </div>
    );
  }

  return children;
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
