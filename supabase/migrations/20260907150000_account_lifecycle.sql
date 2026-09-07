create table if not exists public.account_lifecycle_locks (
  user_id uuid primary key,
  action text not null check (action in ('erase-data', 'delete-account')),
  created_at timestamptz not null default now()
);

alter table public.account_lifecycle_locks enable row level security;

revoke all on public.account_lifecycle_locks from public;
revoke all on public.account_lifecycle_locks from anon;
revoke all on public.account_lifecycle_locks from authenticated;
grant all on public.account_lifecycle_locks to service_role;

create table if not exists public.account_payment_archive (
  payment_order_id text primary key,
  source_user_id uuid not null,
  order_snapshot jsonb not null,
  archived_at timestamptz not null default now(),
  constraint account_payment_archive_snapshot_object check (jsonb_typeof(order_snapshot) = 'object')
);

create index if not exists account_payment_archive_source_user_idx
on public.account_payment_archive (source_user_id, archived_at desc);

alter table public.account_payment_archive enable row level security;

revoke all on public.account_payment_archive from public;
revoke all on public.account_payment_archive from anon;
revoke all on public.account_payment_archive from authenticated;
grant all on public.account_payment_archive to service_role;

create or replace function public.account_lifecycle_is_locked(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.account_lifecycle_locks
    where user_id = p_user_id
  );
$$;

create or replace function public.reject_account_lifecycle_locked()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_user_id uuid;
begin
  v_user_id := coalesce(new.user_id, old.user_id);
  if v_user_id is not null and public.account_lifecycle_is_locked(v_user_id) then
    raise exception 'account lifecycle operation in progress' using errcode = '23514';
  end if;

  return new;
end;
$$;

drop trigger if exists reject_account_lifecycle_locked_workspaces on public.workspaces;
create trigger reject_account_lifecycle_locked_workspaces
before insert or update on public.workspaces
for each row execute function public.reject_account_lifecycle_locked();

drop trigger if exists reject_account_lifecycle_locked_photo_chat_history on public.photo_chat_history;
create trigger reject_account_lifecycle_locked_photo_chat_history
before insert or update on public.photo_chat_history
for each row execute function public.reject_account_lifecycle_locked();

drop trigger if exists reject_account_lifecycle_locked_generated_people on public.generated_people;
create trigger reject_account_lifecycle_locked_generated_people
before insert or update on public.generated_people
for each row execute function public.reject_account_lifecycle_locked();

drop trigger if exists reject_account_lifecycle_locked_moa_ai_requests on public.moa_ai_requests;
create trigger reject_account_lifecycle_locked_moa_ai_requests
before insert or update on public.moa_ai_requests
for each row execute function public.reject_account_lifecycle_locked();

drop trigger if exists reject_account_lifecycle_locked_payment_orders on public.payment_orders;
create trigger reject_account_lifecycle_locked_payment_orders
before insert or update on public.payment_orders
for each row execute function public.reject_account_lifecycle_locked();

revoke all on function public.reject_account_lifecycle_locked() from public;
revoke all on function public.reject_account_lifecycle_locked() from anon;
revoke all on function public.reject_account_lifecycle_locked() from authenticated;
grant execute on function public.reject_account_lifecycle_locked() to service_role;
revoke all on function public.account_lifecycle_is_locked(uuid) from public;
revoke all on function public.account_lifecycle_is_locked(uuid) from anon;
grant execute on function public.account_lifecycle_is_locked(uuid) to authenticated, service_role;

drop policy if exists "Users can upload their moa photos" on storage.objects;
create policy "Users can upload their moa photos"
on storage.objects for insert
to authenticated
with check (
  bucket_id = 'moa-photos'
  and (storage.foldername(name))[1] = (select auth.uid())::text
  and not public.account_lifecycle_is_locked((select auth.uid()))
);

drop policy if exists "Users can replace their moa photos" on storage.objects;
create policy "Users can replace their moa photos"
on storage.objects for update
to authenticated
using (
  bucket_id = 'moa-photos'
  and (storage.foldername(name))[1] = (select auth.uid())::text
  and not public.account_lifecycle_is_locked((select auth.uid()))
)
with check (
  bucket_id = 'moa-photos'
  and (storage.foldername(name))[1] = (select auth.uid())::text
  and not public.account_lifecycle_is_locked((select auth.uid()))
);

drop policy if exists "Users can upload their generated people images" on storage.objects;
create policy "Users can upload their generated people images"
on storage.objects for insert
to authenticated
with check (
  bucket_id = 'moa-people'
  and storage.foldername(name) = array[(select auth.uid())::text]
  and storage.filename(name) ~ '^[A-Za-z0-9][A-Za-z0-9._-]*\.jpg$'
  and not public.account_lifecycle_is_locked((select auth.uid()))
);

revoke all on public.account_lifecycle_locks from public;
revoke all on public.account_payment_archive from public;
