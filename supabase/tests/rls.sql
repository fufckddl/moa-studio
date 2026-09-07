-- Rollback-only integration checks for the Moa Studio Supabase schema.
-- Run this after applying supabase/migrations/*_moa_studio_cloud.sql.
-- It seeds temporary auth.users without email or password values, exercises
-- the real RLS policies as authenticated users, then leaves no rows behind.

begin;

create temporary table moa_rls_subjects (
  user_a uuid not null,
  user_b uuid not null,
  own_photo_name text not null,
  other_photo_name text not null,
  own_person_id text not null,
  other_person_id text not null,
  live_month_order text not null,
  live_stack_order text not null,
  test_month_order text not null,
  live_year_order text not null
) on commit drop;

grant select on moa_rls_subjects to authenticated, service_role;

insert into moa_rls_subjects (
  user_a,
  user_b,
  own_photo_name,
  other_photo_name,
  own_person_id,
  other_person_id,
  live_month_order,
  live_stack_order,
  test_month_order,
  live_year_order
)
select
  gen_random_uuid(),
  gen_random_uuid(),
  'project-a/photo-own.jpg',
  'project-b/photo-other.jpg',
  'person_' || replace(gen_random_uuid()::text, '-', '_'),
  'person_' || replace(gen_random_uuid()::text, '-', '_'),
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
      or unique_violation then
      return;
  end;

  raise exception 'assertion failed: expected rejection for %', label;
end;
$$;

grant execute on function pg_temp.assert_true(boolean, text) to authenticated, service_role;
grant execute on function pg_temp.expect_rejected(text, text) to authenticated, service_role;

-- Seed temporary auth users only for foreign-key validity. No password, email,
-- or deliverable address is inserted, and the surrounding transaction rolls
-- these rows back.
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
  select user_a as user_id from moa_rls_subjects
  union all
  select user_b from moa_rls_subjects
) subject;

-- Service role can prepare rows that a browser client should only be able to
-- read through its own RLS scope.
set local role service_role;

insert into public.workspaces (user_id, brand, projects)
select user_b, '{"name":"Other Cafe"}'::jsonb, '[]'::jsonb
from moa_rls_subjects;

insert into public.photo_chat_history (user_id, conversation_id, messages)
select user_b, 'photo-edit', '[{"role":"user","content":"other account"}]'::jsonb
from moa_rls_subjects;

insert into public.generated_people (user_id, id, name, prompt, storage_path)
select user_b, other_person_id, 'Other person', 'Other account prompt', user_b::text || '/' || other_person_id || '.jpg'
from moa_rls_subjects;

insert into storage.objects (bucket_id, name, metadata)
select 'moa-photos', user_b::text || '/' || other_photo_name, '{"mimetype":"image/jpeg","size":128}'::jsonb
from moa_rls_subjects;

insert into storage.objects (bucket_id, name, metadata)
select 'moa-people', user_b::text || '/' || other_person_id || '.jpg', '{"mimetype":"image/jpeg","size":128}'::jsonb
from moa_rls_subjects;

insert into public.payment_orders (
  id,
  user_id,
  plan,
  interval,
  mode,
  order_name,
  amount,
  expires_at
)
select
  live_month_order,
  user_a,
  'studio',
  'month',
  'live',
  'Studio monthly',
  9900,
  '2026-02-01 00:00:00+00'::timestamptz
from moa_rls_subjects
union all
select
  live_stack_order,
  user_a,
  'plus',
  'month',
  'live',
  'Plus monthly',
  19900,
  '2026-02-15 00:00:00+00'::timestamptz
from moa_rls_subjects
union all
select
  test_month_order,
  user_a,
  'studio',
  'month',
  'test',
  'Studio monthly test',
  9900,
  '2026-02-15 00:00:00+00'::timestamptz
from moa_rls_subjects
union all
select
  live_year_order,
  user_a,
  'plus',
  'year',
  'live',
  'Plus yearly',
  191040,
  '2028-03-01 00:00:00+00'::timestamptz
from moa_rls_subjects;

-- Simulate browser requests as user A. Supabase auth.uid() reads the request
-- JWT settings below; both legacy sub and JSON claims are set for compatibility.
set local role authenticated;
select set_config('request.jwt.claim.sub', user_a::text, true) from moa_rls_subjects;
select set_config(
  'request.jwt.claims',
  jsonb_build_object('sub', user_a::text, 'role', 'authenticated')::text,
  true
)
from moa_rls_subjects;

insert into public.workspaces (user_id, brand, projects)
select user_a, '{"name":"Own Cafe"}'::jsonb, '[]'::jsonb
from moa_rls_subjects;

select pg_temp.assert_true(
  exists (
    select 1
    from public.workspaces
    where user_id = (select user_a from moa_rls_subjects)
      and brand->>'name' = 'Own Cafe'
  ),
  'authenticated user can read own workspace'
);

select pg_temp.assert_true(
  not exists (
    select 1
    from public.workspaces
    where user_id = (select user_b from moa_rls_subjects)
  ),
  'authenticated user cannot read another workspace'
);

update public.workspaces
set brand = '{"name":"Own Cafe Updated"}'::jsonb
where user_id = (select user_a from moa_rls_subjects);

update public.workspaces
set projects = '[
  {
    "id": "project-one",
    "pack": { "cards": [{ "id": "card-1" }, { "id": "card-2" }] },
    "photoChats": {
      "card-1": [
        { "role": "user", "content": "배경을 밝게 바꿔 줘" },
        { "role": "assistant", "content": "밝은 배경 변경안을 만들었어요." }
      ],
      "card-2": []
    }
  }
]'::jsonb
where user_id = (select user_a from moa_rls_subjects);

select pg_temp.assert_true(
  exists (
    select 1
    from public.workspaces
    where user_id = (select user_a from moa_rls_subjects)
      and brand->>'name' = 'Own Cafe Updated'
      and projects #>> '{0,photoChats,card-1,1,content}' = '밝은 배경 변경안을 만들었어요.'
  ),
  'authenticated user can update own workspace with persisted photo chat text'
);

select pg_temp.expect_rejected(
  'photo chat attachment payload',
  $sql$
    update public.workspaces
    set projects = '[
      {
        "id": "project-one",
        "pack": { "cards": [{ "id": "card-1" }] },
        "photoChats": {
          "card-1": [{ "role": "user", "content": "참고 이미지", "references": [] }]
        }
      }
    ]'::jsonb
    where user_id = (select user_a from moa_rls_subjects)
  $sql$
);

select pg_temp.expect_rejected(
  'photo chat unknown card id',
  $sql$
    update public.workspaces
    set projects = '[
      {
        "id": "project-one",
        "pack": { "cards": [{ "id": "card-1" }] },
        "photoChats": {
          "missing-card": [{ "role": "user", "content": "없는 카드" }]
        }
      }
    ]'::jsonb
    where user_id = (select user_a from moa_rls_subjects)
  $sql$
);

select pg_temp.expect_rejected(
  'photo chat null role',
  $sql$
    update public.workspaces
    set projects = '[
      {
        "id": "project-one",
        "pack": { "cards": [{ "id": "card-1" }] },
        "photoChats": {
          "card-1": [{ "role": null, "content": "역할 없음" }]
        }
      }
    ]'::jsonb
    where user_id = (select user_a from moa_rls_subjects)
  $sql$
);

select pg_temp.expect_rejected(
  'photo chat assistant content overflow',
  $sql$
    update public.workspaces
    set projects = jsonb_build_array(jsonb_build_object(
      'id',
      'project-one',
      'pack',
      jsonb_build_object('cards', jsonb_build_array(jsonb_build_object('id', 'card-1'))),
      'photoChats',
      jsonb_build_object('card-1', jsonb_build_array(jsonb_build_object('role', 'assistant', 'content', repeat('응', 4001))))
    ))
    where user_id = (select user_a from moa_rls_subjects)
  $sql$
);

select pg_temp.expect_rejected(
  'cross-user workspace insert',
  'insert into public.workspaces (user_id, brand, projects)
   select user_b, ''{"name":"Blocked"}''::jsonb, ''[]''::jsonb
   from moa_rls_subjects'
);

set local role service_role;
insert into public.account_lifecycle_locks (user_id, action)
select user_a, 'delete-account'
from moa_rls_subjects;

set local role authenticated;
select set_config('request.jwt.claim.sub', user_a::text, true) from moa_rls_subjects;
select set_config(
  'request.jwt.claims',
  jsonb_build_object('sub', user_a::text, 'role', 'authenticated')::text,
  true
)
from moa_rls_subjects;

select pg_temp.expect_rejected(
  'locked account workspace update',
  'update public.workspaces
   set brand = ''{"name":"Locked"}''::jsonb
   where user_id = (select user_a from moa_rls_subjects)'
);

select pg_temp.expect_rejected(
  'locked account photo upload',
  'insert into storage.objects (bucket_id, name, metadata)
   select ''moa-photos'', user_a::text || ''/locked.jpg'', ''{"mimetype":"image/jpeg","size":128}''::jsonb
   from moa_rls_subjects'
);

select pg_temp.expect_rejected(
  'authenticated account lifecycle lock read',
  'select * from public.account_lifecycle_locks'
);

set local role service_role;
delete from public.account_lifecycle_locks
where user_id = (select user_a from moa_rls_subjects);

insert into public.account_payment_archive (payment_order_id, source_user_id, order_snapshot)
select live_month_order, user_a, to_jsonb(po)
from moa_rls_subjects
join public.payment_orders po on po.id = live_month_order;

set local role authenticated;
select set_config('request.jwt.claim.sub', user_a::text, true) from moa_rls_subjects;
select set_config(
  'request.jwt.claims',
  jsonb_build_object('sub', user_a::text, 'role', 'authenticated')::text,
  true
)
from moa_rls_subjects;

select pg_temp.expect_rejected(
  'authenticated payment archive read',
  'select * from public.account_payment_archive'
);

insert into public.photo_chat_history (user_id, conversation_id, messages)
select user_a, 'photo-edit', '[
  { "role": "user", "content": "배경을 밝게 바꿔 줘" },
  { "role": "assistant", "content": "밝은 배경 변경안을 만들었어요." }
]'::jsonb
from moa_rls_subjects;

select pg_temp.assert_true(
  exists (
    select 1
    from public.photo_chat_history
    where user_id = (select user_a from moa_rls_subjects)
      and conversation_id = 'photo-edit'
      and messages #>> '{1,content}' = '밝은 배경 변경안을 만들었어요.'
  ),
  'authenticated user can create and read own photo chat history'
);

select pg_temp.assert_true(
  not exists (
    select 1
    from public.photo_chat_history
    where user_id = (select user_b from moa_rls_subjects)
  ),
  'authenticated user cannot read another photo chat history row'
);

update public.photo_chat_history
set messages = '[{ "role": "user", "content": "새 요청" }]'::jsonb
where user_id = (select user_a from moa_rls_subjects)
  and conversation_id = 'photo-edit';

select pg_temp.assert_true(
  exists (
    select 1
    from public.photo_chat_history
    where user_id = (select user_a from moa_rls_subjects)
      and conversation_id = 'photo-edit'
      and jsonb_array_length(messages) = 1
      and messages #>> '{0,content}' = '새 요청'
  ),
  'authenticated user can update own photo chat history'
);

select pg_temp.expect_rejected(
  'cross-user photo chat insert',
  'insert into public.photo_chat_history (user_id, conversation_id, messages)
   select user_b, ''blocked'', ''[]''::jsonb
   from moa_rls_subjects'
);

do $$
declare
  affected integer;
begin
  update public.photo_chat_history
  set messages = '[{ "role": "user", "content": "blocked" }]'::jsonb
  where user_id = (select user_b from moa_rls_subjects);
  get diagnostics affected = row_count;
  perform pg_temp.assert_true(affected = 0, 'cross-user photo chat update is filtered by RLS');
end;
$$;

select pg_temp.expect_rejected(
  'photo chat attachment payload in history table',
  'insert into public.photo_chat_history (user_id, conversation_id, messages)
   select user_a, ''invalid-attachment'', ''[{ "role": "user", "content": "참고 이미지", "references": [] }]''::jsonb
   from moa_rls_subjects'
);

select pg_temp.expect_rejected(
  'photo chat user content overflow in history table',
  'insert into public.photo_chat_history (user_id, conversation_id, messages)
   select user_a, ''invalid-user-length'', jsonb_build_array(jsonb_build_object(''role'', ''user'', ''content'', repeat(''응'', 2001)))
   from moa_rls_subjects'
);

select pg_temp.expect_rejected(
  'photo chat assistant content overflow in history table',
  'insert into public.photo_chat_history (user_id, conversation_id, messages)
   select user_a, ''invalid-assistant-length'', jsonb_build_array(jsonb_build_object(''role'', ''assistant'', ''content'', repeat(''응'', 4001)))
   from moa_rls_subjects'
);

insert into public.generated_people (user_id, id, name, prompt, storage_path)
select user_a, own_person_id, 'Own person', 'Reusable adult barista', user_a::text || '/' || own_person_id || '.jpg'
from moa_rls_subjects;

select pg_temp.assert_true(
  exists (
    select 1
    from public.generated_people
    where user_id = (select user_a from moa_rls_subjects)
      and name = 'Own person'
      and storage_path = (select user_a::text || '/' || own_person_id || '.jpg' from moa_rls_subjects)
  ),
  'authenticated user can create and read own generated person metadata'
);

select pg_temp.assert_true(
  not exists (
    select 1
    from public.generated_people
    where user_id = (select user_b from moa_rls_subjects)
  ),
  'authenticated user cannot read another generated person metadata row'
);

update public.generated_people
set name = 'Renamed person'
where user_id = (select user_a from moa_rls_subjects)
  and id = (select own_person_id from moa_rls_subjects);

select pg_temp.assert_true(
  exists (
    select 1
    from public.generated_people
    where user_id = (select user_a from moa_rls_subjects)
      and name = 'Renamed person'
  ),
  'authenticated user can rename own generated person metadata'
);

select pg_temp.expect_rejected(
  'cross-user generated person insert',
  'insert into public.generated_people (user_id, id, name, prompt, storage_path)
   select user_b, ''blocked_person'', ''Blocked'', ''Blocked prompt'', user_b::text || ''/blocked_person.jpg''
   from moa_rls_subjects'
);

select pg_temp.expect_rejected(
  'generated person metadata arbitrary storage path',
  'insert into public.generated_people (user_id, id, name, prompt, storage_path)
   select user_a, ''wrong_path'', ''Wrong path'', ''Prompt'', user_a::text || ''/different.jpg''
   from moa_rls_subjects'
);

select pg_temp.expect_rejected(
  'generated person prompt overflow',
  'insert into public.generated_people (user_id, id, name, prompt, storage_path)
   select user_a, ''long_prompt'', ''Long prompt'', repeat(''응'', 2001), user_a::text || ''/long_prompt.jpg''
   from moa_rls_subjects'
);

do $$
declare
  affected integer;
begin
  update public.generated_people
  set name = 'Blocked person'
  where user_id = (select user_b from moa_rls_subjects);
  get diagnostics affected = row_count;
  perform pg_temp.assert_true(affected = 0, 'cross-user generated person update is filtered by RLS');
end;
$$;

do $$
declare
  affected integer;
begin
  update public.workspaces
  set brand = '{"name":"Blocked"}'::jsonb
  where user_id = (select user_b from moa_rls_subjects);
  get diagnostics affected = row_count;
  perform pg_temp.assert_true(affected = 0, 'cross-user workspace update is filtered by RLS');
end;
$$;

insert into storage.objects (bucket_id, name, metadata)
select 'moa-photos', user_a::text || '/' || own_photo_name, '{"mimetype":"image/jpeg","size":128}'::jsonb
from moa_rls_subjects;

select pg_temp.assert_true(
  exists (
    select 1
    from storage.objects
    where bucket_id = 'moa-photos'
      and name = (select user_a::text || '/' || own_photo_name from moa_rls_subjects)
  ),
  'authenticated user can read own storage metadata'
);

select pg_temp.assert_true(
  not exists (
    select 1
    from storage.objects
    where bucket_id = 'moa-photos'
      and name = (select user_b::text || '/' || other_photo_name from moa_rls_subjects)
  ),
  'authenticated user cannot read another user storage metadata'
);

select pg_temp.expect_rejected(
  'cross-user storage insert',
  'insert into storage.objects (bucket_id, name, metadata)
   select ''moa-photos'', user_b::text || ''/blocked.jpg'', ''{"mimetype":"image/jpeg","size":128}''::jsonb
   from moa_rls_subjects'
);

select pg_temp.expect_rejected(
  'move own storage object outside user prefix',
  'update storage.objects
   set name = (select user_b::text || ''/moved.jpg'' from moa_rls_subjects)
   where bucket_id = ''moa-photos''
     and name = (select user_a::text || ''/'' || own_photo_name from moa_rls_subjects)'
);

insert into storage.objects (bucket_id, name, metadata)
select 'moa-people', user_a::text || '/' || own_person_id || '.jpg', '{"mimetype":"image/jpeg","size":128}'::jsonb
from moa_rls_subjects;

select pg_temp.assert_true(
  exists (
    select 1
    from storage.objects
    where bucket_id = 'moa-people'
      and name = (select user_a::text || '/' || own_person_id || '.jpg' from moa_rls_subjects)
  ),
  'authenticated user can read own generated person storage metadata'
);

select pg_temp.assert_true(
  not exists (
    select 1
    from storage.objects
    where bucket_id = 'moa-people'
      and name = (select user_b::text || '/' || other_person_id || '.jpg' from moa_rls_subjects)
  ),
  'authenticated user cannot read another generated person storage metadata row'
);

select pg_temp.expect_rejected(
  'cross-user generated person storage insert',
  'insert into storage.objects (bucket_id, name, metadata)
   select ''moa-people'', user_b::text || ''/blocked_person.jpg'', ''{"mimetype":"image/jpeg","size":128}''::jsonb
   from moa_rls_subjects'
);

select pg_temp.expect_rejected(
  'generated person storage nested path insert',
  'insert into storage.objects (bucket_id, name, metadata)
   select ''moa-people'', user_a::text || ''/nested/blocked.jpg'', ''{"mimetype":"image/jpeg","size":128}''::jsonb
   from moa_rls_subjects'
);

select pg_temp.expect_rejected(
  'generated person storage non-jpg insert',
  'insert into storage.objects (bucket_id, name, metadata)
   select ''moa-people'', user_a::text || ''/blocked.png'', ''{"mimetype":"image/png","size":128}''::jsonb
   from moa_rls_subjects'
);

do $$
declare
  affected integer;
begin
  update storage.objects
  set metadata = '{"mimetype":"image/jpeg","size":256}'::jsonb
  where bucket_id = 'moa-people'
    and name = (select user_a::text || '/' || own_person_id || '.jpg' from moa_rls_subjects);
  get diagnostics affected = row_count;
  perform pg_temp.assert_true(affected = 0, 'client generated person storage overwrite is filtered by RLS');
end;
$$;

do $$
declare
  affected integer;
begin
  update storage.objects
  set metadata = '{"mimetype":"image/jpeg","size":256}'::jsonb
  where bucket_id = 'moa-photos'
    and name = (select user_b::text || '/' || other_photo_name from moa_rls_subjects);
  get diagnostics affected = row_count;
  perform pg_temp.assert_true(affected = 0, 'cross-user storage update is filtered by RLS');
end;
$$;

select pg_temp.assert_true(
  exists (
    select 1
    from public.payment_orders
    where id = (select live_month_order from moa_rls_subjects)
  ),
  'authenticated user can read own payment orders'
);

select pg_temp.expect_rejected(
  'client payment order insert',
  'insert into public.payment_orders (
     id, user_id, plan, interval, mode, order_name, amount, expires_at
   )
   select ''moa_'' || replace(gen_random_uuid()::text, ''-'', ''''), user_a, ''studio'', ''month'', ''live'', ''Blocked'', 9900, now() + interval ''30 minutes''
   from moa_rls_subjects'
);

select pg_temp.expect_rejected(
  'client payment order update',
  'update public.payment_orders
   set status = ''PAID''
   where id = (select live_month_order from moa_rls_subjects)'
);

select pg_temp.expect_rejected(
  'client finalize payment RPC',
  'select public.finalize_payment_order(
     (select live_month_order from moa_rls_subjects),
     ''pay_blocked_client'',
     ''DONE'',
     ''https://dashboard.tosspayments.com/receipt/blocked'',
     ''2026-01-31 10:00:00+00''::timestamptz
   )'
);

-- Service role assertions cover only local database transitions. They do not
-- call Toss or any external payment provider.
set local role service_role;
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claims', '{}', true);

select public.finalize_payment_order(
  (select live_month_order from moa_rls_subjects),
  'pay_live_month',
  'DONE',
  'https://dashboard.tosspayments.com/receipt/live-month',
  '2026-01-31 10:00:00+00'::timestamptz
);

select pg_temp.assert_true(
  exists (
    select 1
    from public.payment_orders
    where id = (select live_month_order from moa_rls_subjects)
      and status = 'PAID'
      and period_start = '2026-01-31 10:00:00+00'::timestamptz
      and period_end = '2026-02-28 10:00:00+00'::timestamptz
  ),
  'live monthly period clamps January 31 to February 28'
);

select public.finalize_payment_order(
  (select live_month_order from moa_rls_subjects),
  'pay_live_month',
  'DONE',
  'https://dashboard.tosspayments.com/receipt/live-month-replay',
  '2026-01-31 10:05:00+00'::timestamptz
);

select pg_temp.expect_rejected(
  'paid order replay with a different payment key',
  'select public.finalize_payment_order(
     (select live_month_order from moa_rls_subjects),
     ''pay_live_month_other_key'',
     ''DONE'',
     ''https://dashboard.tosspayments.com/receipt/live-month-other'',
     ''2026-01-31 10:10:00+00''::timestamptz
   )'
);

select public.finalize_payment_order(
  (select test_month_order from moa_rls_subjects),
  'pay_test_month',
  'DONE',
  'https://dashboard.tosspayments.com/receipt/test-month',
  '2026-02-10 09:00:00+00'::timestamptz
);

select pg_temp.assert_true(
  exists (
    select 1
    from public.payment_orders
    where id = (select test_month_order from moa_rls_subjects)
      and status = 'PAID'
      and period_start = '2026-02-10 09:00:00+00'::timestamptz
      and period_end = '2026-03-10 09:00:00+00'::timestamptz
  ),
  'test payment period starts at its own paid_at and does not stack'
);

select public.finalize_payment_order(
  (select live_stack_order from moa_rls_subjects),
  'pay_live_stack',
  'DONE',
  'https://dashboard.tosspayments.com/receipt/live-stack',
  '2026-02-10 09:30:00+00'::timestamptz
);

select pg_temp.assert_true(
  exists (
    select 1
    from public.payment_orders
    where id = (select live_stack_order from moa_rls_subjects)
      and status = 'PAID'
      and period_start = '2026-02-28 10:00:00+00'::timestamptz
      and period_end = '2026-03-28 10:00:00+00'::timestamptz
  ),
  'live payment stacks after the latest active live period only'
);

select public.finalize_payment_order(
  (select live_year_order from moa_rls_subjects),
  'pay_live_year',
  'DONE',
  'https://dashboard.tosspayments.com/receipt/live-year',
  '2028-02-29 08:00:00+00'::timestamptz
);

select pg_temp.assert_true(
  exists (
    select 1
    from public.payment_orders
    where id = (select live_year_order from moa_rls_subjects)
      and status = 'PAID'
      and period_start = '2028-02-29 08:00:00+00'::timestamptz
      and period_end = '2029-02-28 08:00:00+00'::timestamptz
  ),
  'live yearly period clamps leap day to February 28 the next year'
);

rollback;
