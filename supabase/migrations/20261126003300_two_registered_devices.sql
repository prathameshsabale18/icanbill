begin;

drop function if exists public.claim_auth_session();
drop function if exists public.assert_current_auth_session();

create table if not exists public.registered_subscription_devices (
  user_id uuid not null references auth.users(id) on delete cascade,
  device_hash text not null,
  registered_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  primary key (user_id, device_hash)
);

create table if not exists public.active_device_auth_sessions (
  user_id uuid not null,
  device_hash text not null,
  session_id uuid not null,
  auth_session_created_at timestamptz not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, device_hash),
  foreign key (user_id, device_hash)
    references public.registered_subscription_devices(user_id, device_hash)
    on delete cascade
);

alter table public.registered_subscription_devices enable row level security;
alter table public.active_device_auth_sessions enable row level security;
revoke all on public.registered_subscription_devices from public, anon, authenticated;
revoke all on public.active_device_auth_sessions from public, anon, authenticated;

insert into public.registered_subscription_devices (
  user_id,
  device_hash,
  registered_at,
  last_seen_at
)
select user_id, device_hash, registered_at, updated_at
from public.device_sessions
on conflict (user_id, device_hash) do nothing;

create or replace function public.assert_active_auth_session()
returns void
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_user_id uuid := auth.uid();
  v_session_id uuid := nullif(auth.jwt()->>'session_id', '')::uuid;
begin
  if v_user_id is null or v_session_id is null then
    raise exception 'Authentication required';
  end if;

  if not exists (
    select 1
    from public.active_device_auth_sessions active
    join public.registered_subscription_devices device
      on device.user_id = active.user_id
     and device.device_hash = active.device_hash
    where active.user_id = v_user_id
      and active.session_id = v_session_id
  ) then
    raise exception 'This login is not active on a registered device. Sign in again to continue.';
  end if;
end;
$$;

create or replace function public.assert_current_auth_session(p_device_id text)
returns void
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_user_id uuid := auth.uid();
  v_device_hash text;
  v_session_id uuid := nullif(auth.jwt()->>'session_id', '')::uuid;
begin
  if v_user_id is null or v_session_id is null then
    raise exception 'Authentication required';
  end if;
  if length(coalesce(p_device_id, '')) < 32 then
    raise exception 'This browser could not establish a secure session. Refresh and try again.';
  end if;

  v_device_hash := encode(extensions.digest(p_device_id, 'sha256'), 'hex');
  if not exists (
    select 1
    from public.active_device_auth_sessions active
    join public.registered_subscription_devices device
      on device.user_id = active.user_id
     and device.device_hash = active.device_hash
    where active.user_id = v_user_id
      and active.device_hash = v_device_hash
      and active.session_id = v_session_id
  ) then
    raise exception 'This browser is not active for this subscription. Sign in again or register it as a device.';
  end if;

  perform public.assert_active_auth_session();
end;
$$;

create or replace function public.claim_auth_session(
  p_device_id text,
  p_replace_oldest boolean default false
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_user_id uuid := auth.uid();
  v_session_id uuid := nullif(auth.jwt()->>'session_id', '')::uuid;
  v_session_created_at timestamptz;
  v_device_hash text;
  v_device_count integer;
  v_oldest_device_hash text;
begin
  if v_user_id is null or v_session_id is null then
    raise exception 'Authentication required';
  end if;
  if length(coalesce(p_device_id, '')) < 32 then
    raise exception 'This browser could not establish a secure session. Refresh and try again.';
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

  v_device_hash := encode(extensions.digest(p_device_id, 'sha256'), 'hex');

  if not exists (
    select 1
    from public.registered_subscription_devices device
    where device.user_id = v_user_id
      and device.device_hash = v_device_hash
  ) then
    select count(*) into v_device_count
    from public.registered_subscription_devices device
    where device.user_id = v_user_id;

    if v_device_count >= 2 then
      if not coalesce(p_replace_oldest, false) then
        raise exception 'DEVICE_LIMIT_REACHED: This subscription already has two registered devices.';
      end if;

      select device.device_hash
      into v_oldest_device_hash
      from public.registered_subscription_devices device
      where device.user_id = v_user_id
      order by device.last_seen_at, device.registered_at, device.device_hash
      limit 1
      for update;

      if v_oldest_device_hash is null then
        raise exception 'Could not identify a device to replace. Please try again.';
      end if;

      delete from public.registered_subscription_devices
      where user_id = v_user_id
        and device_hash = v_oldest_device_hash;
    end if;

    insert into public.registered_subscription_devices (user_id, device_hash)
    values (v_user_id, v_device_hash);
  end if;

  update public.registered_subscription_devices
  set last_seen_at = now()
  where user_id = v_user_id
    and device_hash = v_device_hash;

  insert into public.active_device_auth_sessions (
    user_id,
    device_hash,
    session_id,
    auth_session_created_at
  )
  values (v_user_id, v_device_hash, v_session_id, v_session_created_at)
  on conflict (user_id, device_hash) do update
  set session_id = excluded.session_id,
      auth_session_created_at = excluded.auth_session_created_at,
      updated_at = now()
  where public.active_device_auth_sessions.session_id = excluded.session_id
     or public.active_device_auth_sessions.auth_session_created_at <= excluded.auth_session_created_at;

  perform public.assert_current_auth_session(p_device_id);
end;
$$;

create or replace function public.claim_device_session(p_device_id text, p_tab_id text)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  perform public.claim_auth_session(p_device_id, false);
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
    join public.active_device_auth_sessions active
      on active.user_id = member.user_id
    join public.registered_subscription_devices device
      on device.user_id = active.user_id
     and device.device_hash = active.device_hash
    where member.organization_id = p_organization_id
      and member.user_id = auth.uid()
      and active.session_id = nullif(auth.jwt()->>'session_id', '')::uuid
      and subscription.ends_at > now()
  );
$$;

create or replace function public.get_subscription_status()
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_ends_at timestamptz;
  v_starts_at timestamptz;
  v_days_remaining integer;
begin
  perform public.assert_active_auth_session();

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

create or replace function public.get_subscription_status(p_device_id text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_ends_at timestamptz;
  v_starts_at timestamptz;
  v_days_remaining integer;
  v_device_hash text;
begin
  perform public.assert_current_auth_session(p_device_id);

  v_device_hash := encode(extensions.digest(p_device_id, 'sha256'), 'hex');
  update public.registered_subscription_devices
  set last_seen_at = now()
  where user_id = auth.uid()
    and device_hash = v_device_hash;

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
  perform public.assert_current_auth_session(p_device_id);

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
  perform public.assert_active_auth_session();

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

create or replace function public.redeem_subscription_code(p_code text, p_device_id text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  perform public.assert_current_auth_session(p_device_id);
  return public.redeem_subscription_code(p_code);
end;
$$;

revoke all on function public.assert_active_auth_session() from public, anon, authenticated;
revoke all on function public.assert_current_auth_session(text) from public, anon, authenticated;
revoke all on function public.claim_auth_session(text, boolean) from public, anon;
grant execute on function public.claim_auth_session(text, boolean) to authenticated;
revoke all on function public.claim_device_session(text, text) from public, anon;
grant execute on function public.claim_device_session(text, text) to authenticated;
revoke all on function public.get_subscription_status() from public, anon;
revoke all on function public.get_subscription_status(text) from public, anon;
grant execute on function public.get_subscription_status() to authenticated;
grant execute on function public.get_subscription_status(text) to authenticated;
revoke all on function public.assert_device_access(text, text) from public, anon, authenticated;
revoke all on function public.redeem_subscription_code(text) from public, anon;
revoke all on function public.redeem_subscription_code(text, text) from public, anon;
grant execute on function public.redeem_subscription_code(text) to authenticated;
grant execute on function public.redeem_subscription_code(text, text) to authenticated;

notify pgrst, 'reload schema';

commit;
