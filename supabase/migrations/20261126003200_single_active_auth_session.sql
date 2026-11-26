begin;

create table if not exists public.active_auth_sessions (
  user_id uuid primary key references auth.users(id) on delete cascade,
  session_id uuid not null,
  auth_session_created_at timestamptz not null,
  updated_at timestamptz not null default now()
);

alter table public.active_auth_sessions enable row level security;

create or replace function public.assert_current_auth_session()
returns void
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_user_id uuid := auth.uid();
  v_session_id uuid := nullif(auth.jwt()->>'session_id', '')::uuid;
  v_active_session_id uuid;
begin
  if v_user_id is null or v_session_id is null then
    raise exception 'Authentication required';
  end if;

  select active.session_id
  into v_active_session_id
  from public.active_auth_sessions active
  where active.user_id = v_user_id;

  if v_active_session_id is distinct from v_session_id then
    raise exception 'This account was signed in from another browser or device. Sign in again to continue.';
  end if;
end;
$$;

create or replace function public.claim_auth_session()
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_user_id uuid := auth.uid();
  v_session_id uuid := nullif(auth.jwt()->>'session_id', '')::uuid;
  v_session_created_at timestamptz;
begin
  if v_user_id is null or v_session_id is null then
    raise exception 'Authentication required';
  end if;
  if not exists (
    select 1
    from public.organization_members member
    where member.user_id = v_user_id
  ) then
    raise exception 'No paid iCanBill account is associated with this login';
  end if;

  perform 1 from auth.users where id = v_user_id for update;

  select auth_session.created_at
  into v_session_created_at
  from auth.sessions auth_session
  where auth_session.id = v_session_id
    and auth_session.user_id = v_user_id;

  if v_session_created_at is null then
    raise exception 'The login session is no longer valid. Sign in again.';
  end if;

  insert into public.active_auth_sessions (
    user_id,
    session_id,
    auth_session_created_at
  )
  values (v_user_id, v_session_id, v_session_created_at)
  on conflict (user_id) do update
  set session_id = excluded.session_id,
      auth_session_created_at = excluded.auth_session_created_at,
      updated_at = now()
  where public.active_auth_sessions.session_id = excluded.session_id
     or public.active_auth_sessions.auth_session_created_at <= excluded.auth_session_created_at;

  perform public.assert_current_auth_session();
end;
$$;

create or replace function public.claim_device_session(p_device_id text, p_tab_id text)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  perform public.claim_auth_session();
end;
$$;

create or replace function public.is_organization_member(p_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1
    from public.organization_members member
    join public.subscriptions subscription
      on subscription.organization_id = member.organization_id
    join public.active_auth_sessions active
      on active.user_id = member.user_id
    where member.organization_id = p_organization_id
      and member.user_id = auth.uid()
      and active.session_id = nullif(auth.jwt()->>'session_id', '')::uuid
      and subscription.ends_at > now()
  );
$$;

create or replace function public.get_subscription_status()
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_ends_at timestamptz;
  v_starts_at timestamptz;
  v_days_remaining integer;
begin
  perform public.assert_current_auth_session();

  select subscription.starts_at, subscription.ends_at
  into v_starts_at, v_ends_at
  from public.organization_members member
  join public.subscriptions subscription
    on subscription.organization_id = member.organization_id
  where member.user_id = auth.uid()
  order by member.created_at
  limit 1;

  if v_ends_at is null then
    return jsonb_build_object('active', false, 'starts_at', null, 'ends_at', null, 'days_remaining', 0);
  end if;

  v_days_remaining := greatest(0, ceil(extract(epoch from (v_ends_at - now())) / 86400)::integer);
  return jsonb_build_object(
    'active', v_ends_at > now(),
    'starts_at', v_starts_at,
    'ends_at', v_ends_at,
    'days_remaining', v_days_remaining,
    'expiry_reminder_due', v_ends_at > now() and v_ends_at <= now() + interval '5 days'
  );
end;
$$;

create or replace function public.assert_device_access(p_device_id text, p_tab_id text)
returns uuid
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_organization_id uuid;
begin
  perform public.assert_current_auth_session();

  select member.organization_id
  into v_organization_id
  from public.organization_members member
  join public.subscriptions subscription
    on subscription.organization_id = member.organization_id
  where member.user_id = auth.uid()
    and subscription.ends_at > now()
  order by member.created_at
  limit 1;

  if v_organization_id is null then
    raise exception 'An active subscription is required';
  end if;
  return v_organization_id;
end;
$$;

create or replace function public.redeem_subscription_code(p_code text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_user_id uuid := auth.uid();
  v_email text;
  v_organization_id uuid;
  v_code_id uuid;
  v_starts_at timestamptz;
  v_ends_at timestamptz;
begin
  perform public.assert_current_auth_session();

  select lower(email) into v_email
  from auth.users
  where id = v_user_id;

  select id into v_code_id
  from public.subscription_codes
  where code_hash = encode(extensions.digest(upper(trim(coalesce(p_code, ''))), 'sha256'), 'hex')
    and email = v_email
    and redeemed_at is null
  for update;

  if v_code_id is null then
    raise exception 'This activation code is invalid, already used, or belongs to a different email address';
  end if;

  select organization_id into v_organization_id
  from public.organization_members
  where user_id = v_user_id
  order by created_at
  limit 1;

  if v_organization_id is null then
    raise exception 'No iCanBill workspace is associated with this login';
  end if;

  insert into public.subscriptions (organization_id, starts_at, ends_at)
  values (v_organization_id, now(), now() + interval '30 days')
  on conflict (organization_id) do update
  set starts_at = case
        when public.subscriptions.ends_at > now() then public.subscriptions.starts_at
        else now()
      end,
      ends_at = greatest(public.subscriptions.ends_at, now()) + interval '30 days',
      updated_at = now()
  returning starts_at, ends_at into v_starts_at, v_ends_at;

  update public.subscription_codes
  set redeemed_by = v_user_id,
      redeemed_at = now()
  where id = v_code_id;

  return jsonb_build_object('active', true, 'starts_at', v_starts_at, 'ends_at', v_ends_at);
end;
$$;

revoke all on function public.assert_current_auth_session() from public, anon, authenticated;
revoke all on function public.claim_auth_session() from public, anon;
grant execute on function public.claim_auth_session() to authenticated;
revoke all on function public.claim_device_session(text, text) from public, anon;
grant execute on function public.claim_device_session(text, text) to authenticated;
revoke all on function public.get_subscription_status() from public, anon;
grant execute on function public.get_subscription_status() to authenticated;
revoke all on function public.assert_device_access(text, text) from public, anon, authenticated;
revoke all on function public.redeem_subscription_code(text) from public, anon;
grant execute on function public.redeem_subscription_code(text) to authenticated;

notify pgrst, 'reload schema';

commit;
