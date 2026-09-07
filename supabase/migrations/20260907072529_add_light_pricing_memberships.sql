alter table public.payment_orders
  drop constraint if exists payment_orders_plan_check,
  add constraint payment_orders_plan_check check (plan in ('light', 'studio', 'plus'));

alter table public.moa_ai_requests
  drop constraint if exists moa_ai_requests_plan_check,
  add constraint moa_ai_requests_plan_check check (plan in ('light', 'studio', 'plus'));

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
  brand_limit := case v_order.plan
    when 'plus' then 3
    else 1
  end;
  period_start := v_start;
  period_end := v_end;
  return next;
end;
$$;

revoke all on function public.current_moa_ai_entitlement(uuid, timestamptz) from public;
grant execute on function public.current_moa_ai_entitlement(uuid, timestamptz) to authenticated, service_role;
