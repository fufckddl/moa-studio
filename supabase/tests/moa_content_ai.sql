-- Rollback-only integration checks for the Moa Studio paid AI schema.
-- Run after applying supabase/migrations/*_moa_content_ai_backend.sql.

begin;

create temporary table moa_content_subjects (
  user_a uuid not null,
  user_b uuid not null,
  user_c uuid not null,
  user_d uuid not null,
  user_e uuid not null,
  request_a uuid not null,
  request_b uuid not null,
  request_c uuid not null,
  plus_order text not null,
  studio_order text not null,
  light_order text not null,
  user_c_studio_order text not null
) on commit drop;

grant select on moa_content_subjects to authenticated, service_role;

insert into moa_content_subjects (
  user_a,
  user_b,
  user_c,
  user_d,
  user_e,
  request_a,
  request_b,
  request_c,
  plus_order,
  studio_order,
  light_order,
  user_c_studio_order
)
select
  gen_random_uuid(),
  gen_random_uuid(),
  gen_random_uuid(),
  gen_random_uuid(),
  gen_random_uuid(),
  gen_random_uuid(),
  gen_random_uuid(),
  gen_random_uuid(),
  'moa_' || replace(gen_random_uuid()::text, '-', ''),
  'moa_' || replace(gen_random_uuid()::text, '-', ''),
  'moa_' || replace(gen_random_uuid()::text, '-', ''),
  'moa_' || replace(gen_random_uuid()::text, '-', '');

create or replace function pg_temp.assert_true(ok boolean, message text)
returns void
language plpgsql
as $$
begin
  if not coalesce(ok, false) then
    raise exception 'assertion failed: %', message;
  end if;
end;
$$;

create or replace function pg_temp.expect_rejected(label text, statement text)
returns void
language plpgsql
as $$
begin
  begin
    execute statement;
  exception
    when insufficient_privilege
      or check_violation
      or with_check_option_violation
      or raise_exception then
      return;
  end;

  raise exception 'assertion failed: expected rejection for %', label;
end;
$$;

grant execute on function pg_temp.assert_true(boolean, text) to authenticated, service_role;
grant execute on function pg_temp.expect_rejected(text, text) to authenticated, service_role;

insert into auth.users (
  instance_id,
  id,
  aud,
  role,
  raw_app_meta_data,
  raw_user_meta_data,
  created_at,
  updated_at,
  confirmation_token,
  recovery_token,
  email_change,
  email_change_token_new
)
select
  '00000000-0000-0000-0000-000000000000',
  subject.user_id,
  'authenticated',
  'authenticated',
  '{}'::jsonb,
  '{}'::jsonb,
  now(),
  now(),
  '',
  '',
  '',
  ''
from (
  select user_a as user_id from moa_content_subjects
  union all
  select user_b from moa_content_subjects
  union all
  select user_c from moa_content_subjects
  union all
  select user_d from moa_content_subjects
  union all
  select user_e from moa_content_subjects
) subject;

set local role service_role;

insert into public.payment_orders (
  id,
  user_id,
  plan,
  interval,
  mode,
  order_name,
  amount,
  status,
  paid_at,
  period_start,
  period_end,
  expires_at
)
select
  plus_order,
  user_a,
  'plus',
  'year',
  'live',
  'Plus yearly',
  191040,
  'PAID',
  '2026-01-31 10:00:00+00'::timestamptz,
  '2026-01-31 10:00:00+00'::timestamptz,
  '2027-01-31 10:00:00+00'::timestamptz,
  '2026-01-31 10:30:00+00'::timestamptz
from moa_content_subjects
union all
select
  studio_order,
  user_b,
  'studio',
  'month',
  'live',
  'Studio monthly',
  9900,
  'PAID',
  '2026-09-01 00:00:00+00'::timestamptz,
  '2026-09-01 00:00:00+00'::timestamptz,
  '2026-10-01 00:00:00+00'::timestamptz,
  '2026-09-01 00:30:00+00'::timestamptz
from moa_content_subjects
union all
select
  light_order,
  user_c,
  'light',
  'month',
  'live',
  'Light monthly',
  2900,
  'PAID',
  '2026-09-01 00:00:00+00'::timestamptz,
  '2026-09-01 00:00:00+00'::timestamptz,
  '2026-10-01 00:00:00+00'::timestamptz,
  '2026-09-01 00:30:00+00'::timestamptz
from moa_content_subjects
union all
select
  user_c_studio_order,
  user_c,
  'studio',
  'month',
  'live',
  'Standard monthly',
  6900,
  'PAID',
  '2026-09-02 00:00:00+00'::timestamptz,
  '2026-09-02 00:00:00+00'::timestamptz,
  '2026-09-03 00:00:00+00'::timestamptz,
  '2026-09-02 00:30:00+00'::timestamptz
from moa_content_subjects;

select pg_temp.assert_true(
  exists (
    select 1
    from public.current_moa_ai_entitlement(
      (select user_a from moa_content_subjects),
      '2026-09-06 12:00:00+00'::timestamptz
    )
    where plan = 'plus'
      and ai_limit = 100
      and brand_limit = 3
      and period_start = '2026-08-31 10:00:00+00'::timestamptz
      and period_end = '2026-09-30 10:00:00+00'::timestamptz
  ),
  'annual plus entitlement resets monthly with a clamped billing anchor'
);

select pg_temp.assert_true(
  exists (
    select 1
    from public.current_moa_ai_entitlement(
      (select user_c from moa_content_subjects),
      '2026-09-01 12:00:00+00'::timestamptz
    )
    where plan = 'light'
      and ai_limit = 10
      and brand_limit = 3
  ),
  'light entitlement receives ten content generations and three brand profiles'
);

select pg_temp.assert_true(
  not exists (
    select 1
    from public.current_moa_ai_entitlement(
      (select user_d from moa_content_subjects),
      '2026-09-01 12:00:00+00'::timestamptz
    )
  ),
  'free user has no paid content entitlement row'
);

select pg_temp.assert_true(
  exists (
    select 1
    from public.current_moa_ai_entitlement(
      (select user_c from moa_content_subjects),
      '2026-09-02 12:00:00+00'::timestamptz
    )
    where plan = 'studio'
      and ai_limit = 30
      and brand_limit = 3
  ),
  'standard entitlement ranks above overlapping light entitlement'
);

select public.reserve_moa_ai_request(
  (select user_a from moa_content_subjects),
  (select request_a from moa_content_subjects)
);

select pg_temp.assert_true(
  exists (
    select 1
    from public.moa_ai_requests
    where user_id = (select user_a from moa_content_subjects)
      and request_id = (select request_a from moa_content_subjects)
      and status = 'reserved'
  ),
  'service role reserves usage for the authenticated user id only'
);

select public.fail_moa_ai_request(
  (select user_a from moa_content_subjects),
  (select request_a from moa_content_subjects)
);

select pg_temp.assert_true(
  not exists (
    select 1
    from public.moa_ai_requests
    where user_id = (select user_a from moa_content_subjects)
      and request_id = (select request_a from moa_content_subjects)
      and status in ('reserved', 'succeeded')
  ),
  'failed generation is refunded by excluding it from active usage'
);

select public.reserve_moa_ai_request(
  (select user_a from moa_content_subjects),
  (select request_a from moa_content_subjects)
);

select public.succeed_moa_ai_request(
  (select user_a from moa_content_subjects),
  (select request_a from moa_content_subjects),
  '{"source":"ai","cards":[],"caption":"ok","hashtags":[],"schedule":[]}'::jsonb
);

select pg_temp.assert_true(
  exists (
    select 1
    from public.moa_ai_requests
    where user_id = (select user_a from moa_content_subjects)
      and request_id = (select request_a from moa_content_subjects)
      and status = 'succeeded'
      and response->>'source' = 'ai'
  ),
  'successful generation stores idempotent response data'
);

set local role authenticated;
select set_config('request.jwt.claim.sub', user_a::text, true) from moa_content_subjects;
select set_config(
  'request.jwt.claims',
  jsonb_build_object('sub', user_a::text, 'role', 'authenticated')::text,
  true
)
from moa_content_subjects;

select pg_temp.expect_rejected(
  'browser client cannot reserve quota',
  'select public.reserve_moa_ai_request(
     (select user_a from moa_content_subjects),
     (select request_b from moa_content_subjects)
   )'
);

insert into public.workspaces (user_id, brand, projects, brand_profiles, active_brand_id)
select
  user_a,
  '{"name":"Legacy Brand"}'::jsonb,
  '[]'::jsonb,
  '[
    {"id":"brand-a","name":"Cafe A","tagline":"","location":"","instagram":"","color":"#254a3b"},
    {"id":"brand-b","name":"Cafe B","tagline":"","location":"","instagram":"","color":"#a14c2f"},
    {"id":"brand-c","name":"Cafe C","tagline":"","location":"","instagram":"","color":"#3850a8"}
  ]'::jsonb,
  'brand-a'
from moa_content_subjects;

select pg_temp.assert_true(
  exists (
    select 1
    from public.workspaces
    where user_id = (select user_a from moa_content_subjects)
      and jsonb_array_length(brand_profiles) = 3
  ),
  'plus user can store three active brand profiles'
);

set local role service_role;

update public.payment_orders
set period_end = '2026-09-01 00:00:00+00'::timestamptz
where id = (select plus_order from moa_content_subjects);

set local role authenticated;
select set_config('request.jwt.claim.sub', user_a::text, true) from moa_content_subjects;
select set_config(
  'request.jwt.claims',
  jsonb_build_object('sub', user_a::text, 'role', 'authenticated')::text,
  true
)
from moa_content_subjects;

update public.workspaces
set active_brand_id = 'brand-b'
where user_id = (select user_a from moa_content_subjects);

select pg_temp.assert_true(
  exists (
    select 1
    from public.workspaces
    where user_id = (select user_a from moa_content_subjects)
      and jsonb_array_length(brand_profiles) = 3
      and active_brand_id = 'brand-b'
  ),
  'expired plus workspace can keep and switch existing paid brand profiles'
);

select pg_temp.expect_rejected(
  'expired plus workspace cannot expand past its grandfathered brand count',
  'update public.workspaces
   set brand_profiles = brand_profiles || ''[
     {"id":"brand-d","name":"Cafe D","tagline":"","location":"","instagram":"","color":"#3b6f54"}
   ]''::jsonb
   where user_id = (select user_a from moa_content_subjects)'
);

select set_config('request.jwt.claim.sub', user_b::text, true) from moa_content_subjects;
select set_config(
  'request.jwt.claims',
  jsonb_build_object('sub', user_b::text, 'role', 'authenticated')::text,
  true
)
from moa_content_subjects;

select pg_temp.expect_rejected(
  'studio user cannot store more than three brand profiles',
  'insert into public.workspaces (user_id, brand, projects, brand_profiles, active_brand_id)
   select
     user_b,
     ''{"name":"Legacy Brand"}''::jsonb,
     ''[]''::jsonb,
     ''[
       {"id":"brand-a","name":"Cafe A","tagline":"","location":"","instagram":"","color":"#254a3b"},
       {"id":"brand-b","name":"Cafe B","tagline":"","location":"","instagram":"","color":"#a14c2f"},
       {"id":"brand-c","name":"Cafe C","tagline":"","location":"","instagram":"","color":"#3850a8"},
       {"id":"brand-d","name":"Cafe D","tagline":"","location":"","instagram":"","color":"#3b6f54"}
     ]''::jsonb,
     ''brand-a''
   from moa_content_subjects'
);

select set_config('request.jwt.claim.sub', user_d::text, true) from moa_content_subjects;
select set_config(
  'request.jwt.claims',
  jsonb_build_object('sub', user_d::text, 'role', 'authenticated')::text,
  true
)
from moa_content_subjects;

insert into public.workspaces (user_id, brand, projects, brand_profiles, active_brand_id)
select
  user_d,
  '{"name":"Free Brand"}'::jsonb,
  '[]'::jsonb,
  '[
    {"id":"brand-a","name":"Cafe A","tagline":"","location":"","instagram":"","color":"#254a3b"}
  ]'::jsonb,
  'brand-a'
from moa_content_subjects;

select pg_temp.expect_rejected(
  'free user cannot add a second brand profile',
  'update public.workspaces
   set brand_profiles = brand_profiles || ''[
     {"id":"brand-b","name":"Cafe B","tagline":"","location":"","instagram":"","color":"#a14c2f"}
   ]''::jsonb
   where user_id = (select user_d from moa_content_subjects)'
);

reset role;

alter table public.workspaces disable trigger validate_moa_brand_profiles;

insert into public.workspaces (user_id, brand, projects, brand_profiles, active_brand_id)
select
  user_e,
  '{"name":"Legacy Free Brand"}'::jsonb,
  '[]'::jsonb,
  '[
    {"id":"brand-a","name":"Cafe A","tagline":"","location":"","instagram":"","color":"#254a3b"},
    {"id":"brand-b","name":"Cafe B","tagline":"","location":"","instagram":"","color":"#a14c2f"},
    {"id":"brand-c","name":"Cafe C","tagline":"","location":"","instagram":"","color":"#3850a8"}
  ]'::jsonb,
  'brand-a'
from moa_content_subjects;

alter table public.workspaces enable trigger validate_moa_brand_profiles;

set local role authenticated;
select set_config('request.jwt.claim.sub', user_e::text, true) from moa_content_subjects;
select set_config(
  'request.jwt.claims',
  jsonb_build_object('sub', user_e::text, 'role', 'authenticated')::text,
  true
)
from moa_content_subjects;

update public.workspaces
set brand_profiles = jsonb_set(brand_profiles, '{1,name}', '"Cafe B Updated"'::jsonb),
    active_brand_id = 'brand-c'
where user_id = (select user_e from moa_content_subjects);

select pg_temp.assert_true(
  exists (
    select 1
    from public.workspaces
    where user_id = (select user_e from moa_content_subjects)
      and jsonb_array_length(brand_profiles) = 3
      and brand_profiles #>> '{1,name}' = 'Cafe B Updated'
      and active_brand_id = 'brand-c'
  ),
  'grandfathered free workspace can edit and switch existing brand profiles'
);

select pg_temp.expect_rejected(
  'grandfathered free workspace cannot expand past its existing brand count',
  'update public.workspaces
   set brand_profiles = brand_profiles || ''[
     {"id":"brand-d","name":"Cafe D","tagline":"","location":"","instagram":"","color":"#3b6f54"}
   ]''::jsonb
   where user_id = (select user_e from moa_content_subjects)'
);

update public.workspaces
set brand_profiles = jsonb_path_query_array(
      brand_profiles,
      '$[*] ? (@.id != "brand-b")'
    ),
    active_brand_id = 'brand-c'
where user_id = (select user_e from moa_content_subjects);

select pg_temp.assert_true(
  exists (
    select 1
    from public.workspaces
    where user_id = (select user_e from moa_content_subjects)
      and jsonb_array_length(brand_profiles) = 2
      and active_brand_id = 'brand-c'
  ),
  'grandfathered free workspace can delete existing brand profiles'
);

rollback;
