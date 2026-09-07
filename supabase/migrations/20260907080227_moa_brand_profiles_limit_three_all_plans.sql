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
  order by
    case po.plan
      when 'plus' then 3
      when 'studio' then 2
      when 'light' then 1
      else 0
    end desc,
    po.period_end desc
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
  ai_limit := case v_order.plan
    when 'plus' then 100
    when 'studio' then 30
    when 'light' then 10
    else 0
  end;
  brand_limit := 3;
  period_start := v_start;
  period_end := v_end;
  return next;
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
  v_limit integer := 3;
  v_old_count integer := 3;
begin
  if new.brand_profiles is null then
    new.brand_profiles := '[]'::jsonb;
  end if;

  if jsonb_typeof(new.brand_profiles) <> 'array' then
    raise exception 'brand_profiles must be an array' using errcode = '23514';
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

revoke all on function public.current_moa_ai_entitlement(uuid, timestamptz) from public;
revoke all on function public.validate_moa_brand_profiles() from public;

grant execute on function public.current_moa_ai_entitlement(uuid, timestamptz) to authenticated, service_role;
grant execute on function public.validate_moa_brand_profiles() to authenticated, service_role;
