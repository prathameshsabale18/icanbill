create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

alter table public.organizations
  add column if not exists workspace_revision bigint not null default 0;

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'clients','products','invoices','invoice_items','payments','orders',
    'purchase_orders','purchase_order_items','quotations','quotation_items',
    'documents','suppliers'
  ]
  loop
    execute format(
      'alter table public.%I drop constraint if exists %I',
      table_name,
      table_name || '_pkey'
    );
    execute format(
      'alter table public.%I add primary key (organization_id, id)',
      table_name
    );
  end loop;
end;
$$;

create table if not exists public.subscriptions (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.subscription_codes (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  code_hash text not null unique,
  redeemed_by uuid references auth.users(id) on delete set null,
  redeemed_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.device_sessions (
  user_id uuid primary key references auth.users(id) on delete cascade,
  device_hash text not null,
  active_tab_hash text not null,
  lease_expires_at timestamptz not null,
  registered_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.subscriptions enable row level security;
alter table public.subscription_codes enable row level security;
alter table public.device_sessions enable row level security;

create or replace function public.is_organization_member(p_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.organization_members member
    join public.subscriptions subscription
      on subscription.organization_id = member.organization_id
    join public.device_sessions device
      on device.user_id = member.user_id
    where member.organization_id = p_organization_id
      and member.user_id = auth.uid()
      and subscription.ends_at > now()
      and device.lease_expires_at > now()
  );
$$;

create or replace function public.ensure_current_organization()
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_organization_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  select organization_id
  into v_organization_id
  from public.organization_members
  where user_id = auth.uid()
  order by created_at
  limit 1;

  if v_organization_id is null then
    raise exception 'No paid iCanBill account is associated with this login';
  end if;

  return v_organization_id;
end;
$$;

create or replace function public.get_subscription_status()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_ends_at timestamptz;
  v_starts_at timestamptz;
  v_days_remaining integer;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

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

create or replace function public.claim_device_session(p_device_id text, p_tab_id text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_device_hash text;
  v_tab_hash text;
  v_registered_device_hash text;
  v_active_tab_hash text;
  v_lease_expires_at timestamptz;
begin
  if v_user_id is null then
    raise exception 'Authentication required';
  end if;
  if length(coalesce(p_device_id, '')) < 32 or length(coalesce(p_tab_id, '')) < 32 then
    raise exception 'This browser could not establish a secure session. Refresh and try again.';
  end if;
  if not exists (
    select 1 from public.organization_members where user_id = v_user_id
  ) then
    raise exception 'No paid iCanBill account is associated with this login';
  end if;
  perform 1 from auth.users where id = v_user_id for update;

  v_device_hash := encode(extensions.digest(p_device_id, 'sha256'), 'hex');
  v_tab_hash := encode(extensions.digest(p_tab_id, 'sha256'), 'hex');

  select device_hash, active_tab_hash, lease_expires_at
  into v_registered_device_hash, v_active_tab_hash, v_lease_expires_at
  from public.device_sessions
  where user_id = v_user_id
  for update;

  if v_registered_device_hash is not null and v_registered_device_hash <> v_device_hash then
    raise exception 'This account is registered to another browser or device. Contact support to reset it.';
  end if;
  if v_lease_expires_at > now() and v_active_tab_hash <> v_tab_hash then
    raise exception 'This account is already open in another browser tab.';
  end if;

  insert into public.device_sessions (user_id, device_hash, active_tab_hash, lease_expires_at)
  values (v_user_id, v_device_hash, v_tab_hash, now() + interval '90 seconds')
  on conflict (user_id) do update
  set active_tab_hash = excluded.active_tab_hash,
      lease_expires_at = excluded.lease_expires_at,
      updated_at = now();
end;
$$;

create or replace function public.release_device_session(p_device_id text, p_tab_id text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.device_sessions
  set lease_expires_at = now(),
      updated_at = now()
  where user_id = auth.uid()
    and device_hash = encode(extensions.digest(p_device_id, 'sha256'), 'hex')
    and active_tab_hash = encode(extensions.digest(p_tab_id, 'sha256'), 'hex');
end;
$$;

create or replace function public.assert_device_access(p_device_id text, p_tab_id text)
returns uuid
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_organization_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  select member.organization_id
  into v_organization_id
  from public.organization_members member
  join public.subscriptions subscription
    on subscription.organization_id = member.organization_id
  join public.device_sessions device
    on device.user_id = member.user_id
  where member.user_id = auth.uid()
    and subscription.ends_at > now()
    and device.device_hash = encode(extensions.digest(p_device_id, 'sha256'), 'hex')
    and device.active_tab_hash = encode(extensions.digest(p_tab_id, 'sha256'), 'hex')
    and device.lease_expires_at > now()
  order by member.created_at
  limit 1;

  if v_organization_id is null then
    raise exception 'Subscription or active browser session required';
  end if;
  return v_organization_id;
end;
$$;

create or replace function public.redeem_subscription_code(p_code text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_email text;
  v_organization_id uuid;
  v_code_id uuid;
  v_starts_at timestamptz;
  v_ends_at timestamptz;
begin
  if v_user_id is null then
    raise exception 'Authentication required';
  end if;

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

create or replace function public.issue_subscription_code(p_email text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code text := 'ICB-' || upper(encode(extensions.gen_random_bytes(18), 'hex'));
begin
  if p_email is null or length(trim(p_email)) = 0 then
    raise exception 'Customer email is required';
  end if;

  insert into public.subscription_codes (email, code_hash)
  values (
    lower(trim(p_email)),
    encode(extensions.digest(upper(v_code), 'sha256'), 'hex')
  );
  return v_code;
end;
$$;

create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code_id uuid;
  v_organization_id uuid;
  v_code text;
begin
  v_code := upper(trim(coalesce(new.raw_user_meta_data->>'activation_code', '')));
  if v_code = '' then
    raise exception 'A valid paid iCanBill activation code is required';
  end if;

  select id into v_code_id
  from public.subscription_codes
  where code_hash = encode(extensions.digest(v_code, 'sha256'), 'hex')
    and email = lower(new.email)
    and redeemed_at is null
  for update;

  if v_code_id is null then
    raise exception 'This activation code is invalid, already used, or belongs to a different email address';
  end if;

  insert into public.organizations (name)
  values (coalesce(new.raw_user_meta_data->>'display_name', new.email, 'My iCanBill workspace'))
  returning id into v_organization_id;

  insert into public.organization_members (organization_id, user_id, role)
  values (v_organization_id, new.id, 'owner');

  insert into public.subscriptions (organization_id, starts_at, ends_at)
  values (v_organization_id, now(), now() + interval '30 days');

  insert into public.profiles (id, email)
  values (new.id, new.email)
  on conflict (id) do update
  set email = excluded.email, updated_at = now();

  update public.subscription_codes
  set redeemed_by = new.id, redeemed_at = now()
  where id = v_code_id;

  update auth.users
  set raw_user_meta_data = raw_user_meta_data - 'activation_code'
  where id = new.id;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_auth_user();

create or replace function public.get_workspace_snapshot(p_device_id text, p_tab_id text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_organization_id uuid := public.assert_device_access(p_device_id, p_tab_id);
  v_snapshot jsonb;
begin
  select jsonb_build_object(
    'revision', organization.workspace_revision,
    'tables', jsonb_build_object(
      'clients', coalesce((select jsonb_agg(data || jsonb_build_object('id', id, 'created_at', created_at, 'updated_at', updated_at)) from public.clients where organization_id = v_organization_id), '[]'::jsonb),
      'documents', coalesce((select jsonb_agg(data || jsonb_build_object('id', id, 'created_at', created_at, 'updated_at', updated_at)) from public.documents where organization_id = v_organization_id), '[]'::jsonb),
      'invoice_items', coalesce((select jsonb_agg(data || jsonb_build_object('id', id, 'created_at', created_at, 'updated_at', updated_at)) from public.invoice_items where organization_id = v_organization_id), '[]'::jsonb),
      'invoices', coalesce((select jsonb_agg(data || jsonb_build_object('id', id, 'created_at', created_at, 'updated_at', updated_at)) from public.invoices where organization_id = v_organization_id), '[]'::jsonb),
      'orders', coalesce((select jsonb_agg(data || jsonb_build_object('id', id, 'created_at', created_at, 'updated_at', updated_at)) from public.orders where organization_id = v_organization_id), '[]'::jsonb),
      'payments', coalesce((select jsonb_agg(data || jsonb_build_object('id', id, 'created_at', created_at, 'updated_at', updated_at)) from public.payments where organization_id = v_organization_id), '[]'::jsonb),
      'products', coalesce((select jsonb_agg(data || jsonb_build_object('id', id, 'created_at', created_at, 'updated_at', updated_at)) from public.products where organization_id = v_organization_id), '[]'::jsonb),
      'purchase_order_items', coalesce((select jsonb_agg(data || jsonb_build_object('id', id, 'created_at', created_at, 'updated_at', updated_at)) from public.purchase_order_items where organization_id = v_organization_id), '[]'::jsonb),
      'purchase_orders', coalesce((select jsonb_agg(data || jsonb_build_object('id', id, 'created_at', created_at, 'updated_at', updated_at)) from public.purchase_orders where organization_id = v_organization_id), '[]'::jsonb),
      'quotation_items', coalesce((select jsonb_agg(data || jsonb_build_object('id', id, 'created_at', created_at, 'updated_at', updated_at)) from public.quotation_items where organization_id = v_organization_id), '[]'::jsonb),
      'quotations', coalesce((select jsonb_agg(data || jsonb_build_object('id', id, 'created_at', created_at, 'updated_at', updated_at)) from public.quotations where organization_id = v_organization_id), '[]'::jsonb),
      'suppliers', coalesce((select jsonb_agg(data || jsonb_build_object('id', id, 'created_at', created_at, 'updated_at', updated_at)) from public.suppliers where organization_id = v_organization_id), '[]'::jsonb),
      'business_settings', coalesce((select data from public.business_settings where organization_id = v_organization_id), '[]'::jsonb)
    )
  )
  into v_snapshot
  from public.organizations organization
  where organization.id = v_organization_id;

  if jsonb_typeof(v_snapshot->'tables'->'business_settings') <> 'array' then
    v_snapshot := jsonb_set(v_snapshot, '{tables,business_settings}', jsonb_build_array(v_snapshot->'tables'->'business_settings'));
  end if;
  if v_snapshot->'tables'->'business_settings' = '[null]'::jsonb then
    v_snapshot := jsonb_set(v_snapshot, '{tables,business_settings}', '[]'::jsonb);
  end if;
  return v_snapshot;
end;
$$;

create or replace function public.save_workspace_snapshot(
  p_snapshot jsonb,
  p_expected_revision bigint,
  p_device_id text,
  p_tab_id text
)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_organization_id uuid := public.assert_device_access(p_device_id, p_tab_id);
  v_current_revision bigint;
  v_table text;
  v_row jsonb;
begin
  select workspace_revision into v_current_revision
  from public.organizations
  where id = v_organization_id
  for update;

  if v_current_revision <> p_expected_revision then
    raise exception 'Workspace changed in another request. Refresh and try again.';
  end if;
  if jsonb_typeof(p_snapshot->'tables') <> 'object' then
    raise exception 'Invalid workspace snapshot';
  end if;

  foreach v_table in array array[
    'clients','documents','invoice_items','invoices','orders','payments','products',
    'purchase_order_items','purchase_orders','quotation_items','quotations','suppliers'
  ]
  loop
    if jsonb_typeof(p_snapshot->'tables'->v_table) <> 'array' then
      raise exception 'Invalid workspace data for %', v_table;
    end if;
    execute format('delete from public.%I where organization_id = $1', v_table)
      using v_organization_id;

    for v_row in select value from jsonb_array_elements(p_snapshot->'tables'->v_table)
    loop
      if v_table = 'invoices' then
        insert into public.invoices (id, organization_id, invoice_no, data, created_at, updated_at)
        values ((v_row->>'id')::bigint, v_organization_id, v_row->>'invoice_no', v_row,
          coalesce((v_row->>'created_at')::timestamptz, now()),
          coalesce((v_row->>'updated_at')::timestamptz, now()));
      elsif v_table = 'purchase_orders' then
        insert into public.purchase_orders (id, organization_id, po_no, data, created_at, updated_at)
        values ((v_row->>'id')::bigint, v_organization_id, v_row->>'po_no', v_row,
          coalesce((v_row->>'created_at')::timestamptz, now()),
          coalesce((v_row->>'updated_at')::timestamptz, now()));
      elsif v_table = 'quotations' then
        insert into public.quotations (id, organization_id, quotation_no, data, created_at, updated_at)
        values ((v_row->>'id')::bigint, v_organization_id, v_row->>'quotation_no', v_row,
          coalesce((v_row->>'created_at')::timestamptz, now()),
          coalesce((v_row->>'updated_at')::timestamptz, now()));
      elsif v_table = 'invoice_items' or v_table = 'payments' then
        execute format(
          'insert into public.%I (id, organization_id, invoice_id, data, created_at, updated_at) values ($1, $2, $3, $4, $5, $6)',
          v_table
        ) using (v_row->>'id')::bigint, v_organization_id,
          nullif(v_row->>'invoice_id', '')::bigint, v_row,
          coalesce((v_row->>'created_at')::timestamptz, now()),
          coalesce((v_row->>'updated_at')::timestamptz, now());
      elsif v_table = 'purchase_order_items' then
        insert into public.purchase_order_items (id, organization_id, purchase_order_id, data, created_at, updated_at)
        values ((v_row->>'id')::bigint, v_organization_id,
          nullif(v_row->>'purchase_order_id', '')::bigint, v_row,
          coalesce((v_row->>'created_at')::timestamptz, now()),
          coalesce((v_row->>'updated_at')::timestamptz, now()));
      elsif v_table = 'quotation_items' then
        insert into public.quotation_items (id, organization_id, quotation_id, data, created_at, updated_at)
        values ((v_row->>'id')::bigint, v_organization_id,
          nullif(v_row->>'quotation_id', '')::bigint, v_row,
          coalesce((v_row->>'created_at')::timestamptz, now()),
          coalesce((v_row->>'updated_at')::timestamptz, now()));
      else
        execute format(
          'insert into public.%I (id, organization_id, data, created_at, updated_at) values ($1, $2, $3, $4, $5)',
          v_table
        ) using (v_row->>'id')::bigint, v_organization_id, v_row,
          coalesce((v_row->>'created_at')::timestamptz, now()),
          coalesce((v_row->>'updated_at')::timestamptz, now());
      end if;
    end loop;
  end loop;

  v_row := coalesce(p_snapshot->'tables'->'business_settings'->0, '{}'::jsonb);
  if v_row = '{}'::jsonb then
    delete from public.business_settings where organization_id = v_organization_id;
  else
    insert into public.business_settings (organization_id, data, created_at, updated_at)
    values (
      v_organization_id,
      v_row,
      coalesce((v_row->>'created_at')::timestamptz, now()),
      coalesce((v_row->>'updated_at')::timestamptz, now())
    )
    on conflict (organization_id) do update
    set data = excluded.data, updated_at = excluded.updated_at;
  end if;

  update public.organizations
  set workspace_revision = workspace_revision + 1,
      updated_at = now()
  where id = v_organization_id
  returning workspace_revision into v_current_revision;
  return v_current_revision;
end;
$$;

insert into storage.buckets (id, name, public)
values ('invoice-pdfs', 'invoice-pdfs', false), ('documents', 'documents', false)
on conflict (id) do update set public = false;

drop policy if exists "workspace files access" on storage.objects;
create policy "workspace files access" on storage.objects
for all to authenticated
using (
  bucket_id in ('invoice-pdfs', 'documents')
  and exists (
    select 1 from public.organization_members member
    where member.user_id = auth.uid()
      and (storage.foldername(name))[1] = member.organization_id::text
      and public.is_organization_member(member.organization_id)
  )
)
with check (
  bucket_id in ('invoice-pdfs', 'documents')
  and exists (
    select 1 from public.organization_members member
    where member.user_id = auth.uid()
      and (storage.foldername(name))[1] = member.organization_id::text
      and public.is_organization_member(member.organization_id)
  )
);

revoke all on function public.issue_subscription_code(text) from public, anon, authenticated;
grant execute on function public.issue_subscription_code(text) to service_role;
revoke all on function public.get_subscription_status() from public, anon;
revoke all on function public.claim_device_session(text, text) from public, anon;
revoke all on function public.release_device_session(text, text) from public, anon;
revoke all on function public.redeem_subscription_code(text) from public, anon;
revoke all on function public.get_workspace_snapshot(text, text) from public, anon;
revoke all on function public.save_workspace_snapshot(jsonb, bigint, text, text) from public, anon;
revoke all on function public.assert_device_access(text, text) from public, anon, authenticated;

grant execute on function public.get_subscription_status() to authenticated;
grant execute on function public.claim_device_session(text, text) to authenticated;
grant execute on function public.release_device_session(text, text) to authenticated;
grant execute on function public.redeem_subscription_code(text) to authenticated;
grant execute on function public.get_workspace_snapshot(text, text) to authenticated;
grant execute on function public.save_workspace_snapshot(jsonb, bigint, text, text) to authenticated;
grant execute on function public.ensure_current_organization() to authenticated;
