create table if not exists public.workspaces (
  user_id uuid primary key references auth.users(id) on delete cascade,
  brand jsonb,
  projects jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now(),
  constraint workspaces_projects_array check (jsonb_typeof(projects) = 'array')
);

alter table public.workspaces enable row level security;

revoke all on public.workspaces from anon;
revoke all on public.workspaces from authenticated;
grant select, insert, update, delete on public.workspaces to authenticated;
grant all on public.workspaces to service_role;

drop policy if exists "Users can read their workspace" on public.workspaces;
create policy "Users can read their workspace"
on public.workspaces for select
to authenticated
using ((select auth.uid()) = user_id);

drop policy if exists "Users can create their workspace" on public.workspaces;
create policy "Users can create their workspace"
on public.workspaces for insert
to authenticated
with check ((select auth.uid()) = user_id);

drop policy if exists "Users can update their workspace" on public.workspaces;
create policy "Users can update their workspace"
on public.workspaces for update
to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

drop policy if exists "Users can delete their workspace" on public.workspaces;
create policy "Users can delete their workspace"
on public.workspaces for delete
to authenticated
using ((select auth.uid()) = user_id);

create table if not exists public.payment_orders (
  id text primary key check (id ~ '^moa_[0-9a-f]{32}$'),
  user_id uuid not null references auth.users(id) on delete cascade,
  plan text not null check (plan in ('studio', 'plus')),
  interval text not null check (interval in ('month', 'year')),
  mode text not null check (mode in ('test', 'live')),
  order_name text not null,
  amount integer not null check (amount > 0),
  currency text not null default 'KRW' check (currency = 'KRW'),
  status text not null default 'PENDING' check (status in ('PENDING', 'PAID', 'FAILED', 'CANCELED')),
  toss_payment_key text unique,
  toss_status text,
  receipt_url text,
  paid_at timestamptz,
  period_start timestamptz,
  period_end timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create index if not exists payment_orders_user_status_idx on public.payment_orders (user_id, status, period_end desc);
create index if not exists payment_orders_expires_at_idx on public.payment_orders (expires_at);

alter table public.payment_orders enable row level security;

revoke all on public.payment_orders from anon;
revoke all on public.payment_orders from authenticated;
grant select on public.payment_orders to authenticated;
grant all on public.payment_orders to service_role;

drop policy if exists "Users can read their payment orders" on public.payment_orders;
create policy "Users can read their payment orders"
on public.payment_orders for select
to authenticated
using ((select auth.uid()) = user_id);

create or replace function public.finalize_payment_order(
  p_order_id text,
  p_payment_key text,
  p_toss_status text,
  p_receipt_url text,
  p_paid_at timestamptz
)
returns public.payment_orders
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_order public.payment_orders;
  v_period_start timestamptz;
  v_period_end timestamptz;
begin
  select *
  into v_order
  from public.payment_orders
  where id = p_order_id
  for update;

  if not found then
    raise exception 'payment order not found' using errcode = 'P0002';
  end if;

  if v_order.status = 'PAID' then
    if v_order.toss_payment_key is distinct from p_payment_key then
      raise exception 'payment order already paid with another key' using errcode = '23505';
    end if;
    return v_order;
  end if;

  if v_order.status <> 'PENDING' then
    raise exception 'payment order is not pending' using errcode = 'P0001';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_order.user_id::text, 0));

  if v_order.mode = 'live' then
    select greatest(p_paid_at, coalesce(max(period_end), p_paid_at))
    into v_period_start
    from public.payment_orders
    where user_id = v_order.user_id
      and status = 'PAID'
      and mode = 'live'
      and period_end > p_paid_at;
  else
    v_period_start := p_paid_at;
  end if;

  v_period_end := case v_order.interval
    when 'year' then v_period_start + interval '1 year'
    else v_period_start + interval '1 month'
  end;

  update public.payment_orders
  set status = 'PAID',
      toss_payment_key = p_payment_key,
      toss_status = p_toss_status,
      receipt_url = p_receipt_url,
      paid_at = p_paid_at,
      period_start = v_period_start,
      period_end = v_period_end,
      updated_at = p_paid_at
  where id = p_order_id
    and status = 'PENDING'
  returning *
  into v_order;

  return v_order;
end;
$$;

revoke all on function public.finalize_payment_order(text, text, text, text, timestamptz) from public;
revoke all on function public.finalize_payment_order(text, text, text, text, timestamptz) from anon;
revoke all on function public.finalize_payment_order(text, text, text, text, timestamptz) from authenticated;
grant execute on function public.finalize_payment_order(text, text, text, text, timestamptz) to service_role;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('moa-photos', 'moa-photos', false, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Users can read their moa photos" on storage.objects;
create policy "Users can read their moa photos"
on storage.objects for select
to authenticated
using (
  bucket_id = 'moa-photos'
  and (storage.foldername(name))[1] = (select auth.uid())::text
);

drop policy if exists "Users can upload their moa photos" on storage.objects;
create policy "Users can upload their moa photos"
on storage.objects for insert
to authenticated
with check (
  bucket_id = 'moa-photos'
  and (storage.foldername(name))[1] = (select auth.uid())::text
);

drop policy if exists "Users can replace their moa photos" on storage.objects;
create policy "Users can replace their moa photos"
on storage.objects for update
to authenticated
using (
  bucket_id = 'moa-photos'
  and (storage.foldername(name))[1] = (select auth.uid())::text
)
with check (
  bucket_id = 'moa-photos'
  and (storage.foldername(name))[1] = (select auth.uid())::text
);

drop policy if exists "Users can delete their moa photos" on storage.objects;
create policy "Users can delete their moa photos"
on storage.objects for delete
to authenticated
using (
  bucket_id = 'moa-photos'
  and (storage.foldername(name))[1] = (select auth.uid())::text
);
