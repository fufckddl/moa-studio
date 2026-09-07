alter table public.workspaces
  add column if not exists brand_profiles jsonb not null default '[]'::jsonb,
  add column if not exists active_brand_id text;

alter table public.workspaces
  drop constraint if exists workspaces_brand_profiles_array,
  add constraint workspaces_brand_profiles_array check (jsonb_typeof(brand_profiles) = 'array');

create table if not exists public.moa_ai_requests (
  id bigserial primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  request_id uuid not null,
  status text not null check (status in ('reserved', 'succeeded', 'failed')),
  plan text not null check (plan in ('studio', 'plus')),
  period_start timestamptz not null,
  period_end timestamptz not null,
  response jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  constraint moa_ai_requests_period_order check (period_end > period_start),
  constraint moa_ai_requests_response_object check (response is null or jsonb_typeof(response) = 'object'),
  unique (user_id, request_id)
);

create index if not exists moa_ai_requests_user_period_idx
on public.moa_ai_requests (user_id, period_start, period_end, status);

create index if not exists moa_ai_requests_user_created_idx
on public.moa_ai_requests (user_id, created_at desc);

alter table public.moa_ai_requests enable row level security;

revoke all on public.moa_ai_requests from anon;
revoke all on public.moa_ai_requests from authenticated;
grant select on public.moa_ai_requests to authenticated;
grant all on public.moa_ai_requests to service_role;

drop policy if exists "Users can read their AI requests" on public.moa_ai_requests;
create policy "Users can read their AI requests"
on public.moa_ai_requests for select
to authenticated
using ((select auth.uid()) = user_id);

create or replace function public.moa_add_months_clamped(
  p_value timestamptz,
  p_months integer,
  p_anchor_day integer
)
returns timestamptz
language sql
immutable
set search_path = ''
as $$
  select (
    date_trunc('month', p_value at time zone 'UTC')
    + (p_months || ' months')::interval
    + (least(
        p_anchor_day,
        extract(day from (
          date_trunc('month', p_value at time zone 'UTC')
          + ((p_months + 1) || ' months')::interval
          - interval '1 day'
        ))::integer
      ) - 1) * interval '1 day'
    + ((p_value at time zone 'UTC') - date_trunc('day', p_value at time zone 'UTC'))
  ) at time zone 'UTC';
$$;

create or replace function public.current_moa_ai_entitlement(
  p_user_id uuid,
  p_now timestamptz default now()
)
returns table (
  plan text,
  ai_limit integer,
  brand_limit integer,
  period_start timestamptz,
  period_end timestamptz
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_order public.payment_orders;
  v_start timestamptz;
  v_end timestamptz;
  v_anchor_day integer;
begin
  select *
  into v_order
  from public.payment_orders as po
  where po.user_id = p_user_id
    and po.status = 'PAID'
    and po.mode = 'live'
    and po.period_start <= p_now
    and po.period_end > p_now
  order by case po.plan when 'plus' then 2 else 1 end desc, po.period_end desc
  limit 1;

  if not found then
    return;
  end if;

  v_anchor_day := extract(day from v_order.period_start at time zone 'UTC')::integer;
  v_start := v_order.period_start;
  v_end := public.moa_add_months_clamped(v_start, 1, v_anchor_day);

  while v_end <= p_now and v_end < v_order.period_end loop
    v_start := v_end;
    v_end := public.moa_add_months_clamped(v_start, 1, v_anchor_day);
  end loop;

  if v_end > v_order.period_end then
    v_end := v_order.period_end;
  end if;

  plan := v_order.plan;
  ai_limit := case v_order.plan when 'plus' then 100 else 30 end;
  brand_limit := case v_order.plan when 'plus' then 3 else 1 end;
  period_start := v_start;
  period_end := v_end;
  return next;
end;
$$;

create or replace function public.reserve_moa_ai_request(
  p_user_id uuid,
  p_request_id uuid
)
returns public.moa_ai_requests
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_existing public.moa_ai_requests;
  v_entitlement record;
  v_used integer;
  v_burst integer;
  v_request public.moa_ai_requests;
  v_has_existing boolean := false;
begin
  if p_user_id is null or p_request_id is null then
    raise exception 'moa_ai_invalid_request' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('moa-ai:' || p_user_id::text, 0));

  select *
  into v_existing
  from public.moa_ai_requests
  where user_id = p_user_id
    and request_id = p_request_id
  for update;
  v_has_existing := found;

  if v_has_existing and v_existing.status = 'succeeded' then
    return v_existing;
  end if;

  if v_has_existing and v_existing.status = 'reserved' then
    if v_existing.updated_at > now() - interval '2 minutes' then
      raise exception 'moa_ai_request_in_progress' using errcode = 'P0001';
    end if;
    update public.moa_ai_requests
    set status = 'failed',
        updated_at = now(),
        completed_at = now()
    where id = v_existing.id
    returning *
    into v_existing;
  end if;

  select *
  into v_entitlement
  from public.current_moa_ai_entitlement(p_user_id, now());

  if not found then
    raise exception 'moa_ai_no_entitlement' using errcode = 'P0001';
  end if;

  select count(*)
  into v_burst
  from public.moa_ai_requests
  where user_id = p_user_id
    and created_at > now() - interval '1 minute';

  if v_burst >= 12 then
    raise exception 'moa_ai_rate_limited' using errcode = 'P0001';
  end if;

  select count(*)
  into v_used
  from public.moa_ai_requests
  where user_id = p_user_id
    and status in ('reserved', 'succeeded')
    and period_start = v_entitlement.period_start
    and period_end = v_entitlement.period_end;

  if v_used >= v_entitlement.ai_limit then
    raise exception 'moa_ai_quota_exceeded' using errcode = 'P0001';
  end if;

  if v_has_existing and v_existing.status = 'failed' then
    update public.moa_ai_requests
    set status = 'reserved',
        plan = v_entitlement.plan,
        period_start = v_entitlement.period_start,
        period_end = v_entitlement.period_end,
        response = null,
        updated_at = now(),
        completed_at = null
    where id = v_existing.id
    returning *
    into v_request;
  else
    insert into public.moa_ai_requests (
      user_id,
      request_id,
      status,
      plan,
      period_start,
      period_end
    )
    values (
      p_user_id,
      p_request_id,
      'reserved',
      v_entitlement.plan,
      v_entitlement.period_start,
      v_entitlement.period_end
    )
    returning *
    into v_request;
  end if;

  return v_request;
end;
$$;

create or replace function public.succeed_moa_ai_request(
  p_user_id uuid,
  p_request_id uuid,
  p_response jsonb
)
returns public.moa_ai_requests
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_request public.moa_ai_requests;
begin
  if p_response is null or jsonb_typeof(p_response) <> 'object' then
    raise exception 'moa_ai_invalid_response' using errcode = '22023';
  end if;

  update public.moa_ai_requests
  set status = 'succeeded',
      response = p_response,
      updated_at = now(),
      completed_at = now()
  where user_id = p_user_id
    and request_id = p_request_id
    and status = 'reserved'
  returning *
  into v_request;

  if not found then
    select *
    into v_request
    from public.moa_ai_requests
    where user_id = p_user_id
      and request_id = p_request_id
      and status = 'succeeded';
  end if;

  if not found then
    raise exception 'moa_ai_request_not_reserved' using errcode = 'P0002';
  end if;

  return v_request;
end;
$$;

create or replace function public.fail_moa_ai_request(
  p_user_id uuid,
  p_request_id uuid
)
returns public.moa_ai_requests
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_request public.moa_ai_requests;
begin
  update public.moa_ai_requests
  set status = 'failed',
      updated_at = now(),
      completed_at = now()
  where user_id = p_user_id
    and request_id = p_request_id
    and status = 'reserved'
  returning *
  into v_request;

  return v_request;
end;
$$;

create or replace function public.validate_moa_brand_profiles()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_profile jsonb;
  v_ids text[] := array[]::text[];
  v_id text;
  v_limit integer := 1;
  v_old_count integer := 1;
  v_plan text;
begin
  if new.brand_profiles is null then
    new.brand_profiles := '[]'::jsonb;
  end if;

  if jsonb_typeof(new.brand_profiles) <> 'array' then
    raise exception 'brand_profiles must be an array' using errcode = '23514';
  end if;

  select plan
  into v_plan
  from public.current_moa_ai_entitlement(new.user_id, now())
  limit 1;

  if v_plan = 'plus' then
    v_limit := 3;
  else
    v_limit := 1;
  end if;

  if tg_op = 'UPDATE' and old.brand_profiles is not null and jsonb_typeof(old.brand_profiles) = 'array' then
    v_old_count := jsonb_array_length(old.brand_profiles);
    v_limit := greatest(v_limit, v_old_count);
  end if;

  if jsonb_array_length(new.brand_profiles) > v_limit then
    raise exception 'brand profile limit exceeded' using errcode = '23514';
  end if;

  for v_profile in select value from jsonb_array_elements(new.brand_profiles) loop
    if jsonb_typeof(v_profile) <> 'object' then
      raise exception 'brand profile must be an object' using errcode = '23514';
    end if;

    v_id := v_profile->>'id';
    if coalesce(v_id, '') = ''
      or coalesce(v_profile->>'name', '') = ''
      or not (v_profile ? 'tagline')
      or not (v_profile ? 'location')
      or not (v_profile ? 'instagram')
      or not (v_profile ? 'color')
      or (v_profile->>'color') !~ '^#[0-9A-Fa-f]{6}$'
    then
      raise exception 'brand profile shape is invalid' using errcode = '23514';
    end if;

    if v_id = any(v_ids) then
      raise exception 'brand profile ids must be unique' using errcode = '23514';
    end if;
    v_ids := array_append(v_ids, v_id);
  end loop;

  if new.active_brand_id is not null and not (new.active_brand_id = any(v_ids)) then
    raise exception 'active brand must exist in brand_profiles' using errcode = '23514';
  end if;

  return new;
end;
$$;

drop trigger if exists validate_moa_brand_profiles on public.workspaces;
create trigger validate_moa_brand_profiles
before insert or update of brand_profiles, active_brand_id, user_id on public.workspaces
for each row execute function public.validate_moa_brand_profiles();

revoke all on function public.moa_add_months_clamped(timestamptz, integer, integer) from public;
revoke all on function public.current_moa_ai_entitlement(uuid, timestamptz) from public;
revoke all on function public.reserve_moa_ai_request(uuid, uuid) from public;
revoke all on function public.succeed_moa_ai_request(uuid, uuid, jsonb) from public;
revoke all on function public.fail_moa_ai_request(uuid, uuid) from public;
revoke all on function public.validate_moa_brand_profiles() from public;

grant execute on function public.moa_add_months_clamped(timestamptz, integer, integer) to authenticated, service_role;
grant execute on function public.current_moa_ai_entitlement(uuid, timestamptz) to authenticated, service_role;
grant execute on function public.reserve_moa_ai_request(uuid, uuid) to service_role;
grant execute on function public.succeed_moa_ai_request(uuid, uuid, jsonb) to service_role;
grant execute on function public.fail_moa_ai_request(uuid, uuid) to service_role;
grant execute on function public.validate_moa_brand_profiles() to authenticated, service_role;
