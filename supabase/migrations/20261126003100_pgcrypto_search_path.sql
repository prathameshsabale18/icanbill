create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

alter function public.claim_device_session(text, text)
  set search_path = extensions, pg_catalog;
alter function public.release_device_session(text, text)
  set search_path = extensions, pg_catalog;
alter function public.assert_device_access(text, text)
  set search_path = extensions, pg_catalog;
alter function public.redeem_subscription_code(text)
  set search_path = extensions, pg_catalog;
alter function public.issue_subscription_code(text)
  set search_path = extensions, pg_catalog;
alter function public.handle_new_auth_user()
  set search_path = extensions, pg_catalog;

notify pgrst, 'reload schema';
