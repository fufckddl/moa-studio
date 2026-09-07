create table if not exists public.generated_people (
  user_id uuid not null references auth.users(id) on delete cascade,
  id text not null,
  name text not null,
  prompt text not null,
  storage_path text not null,
  created_at timestamptz not null default now(),
  primary key (user_id, id),
  constraint generated_people_id_check check (
    length(id) between 1 and 120
    and id ~ '^[A-Za-z0-9][A-Za-z0-9._-]*$'
  ),
  constraint generated_people_name_check check (
    length(btrim(name)) between 1 and 80
  ),
  constraint generated_people_prompt_check check (
    length(btrim(prompt)) between 1 and 2000
  ),
  constraint generated_people_storage_path_check check (
    storage_path = user_id::text || '/' || id || '.jpg'
  )
);

create index if not exists generated_people_user_created_idx
on public.generated_people (user_id, created_at desc);

alter table public.generated_people enable row level security;

revoke all on public.generated_people from anon;
revoke all on public.generated_people from authenticated;
grant select, insert, delete on public.generated_people to authenticated;
grant update (name) on public.generated_people to authenticated;
grant all on public.generated_people to service_role;

drop policy if exists "Users can read their generated people" on public.generated_people;
create policy "Users can read their generated people"
on public.generated_people for select
to authenticated
using ((select auth.uid()) = user_id);

drop policy if exists "Users can create their generated people" on public.generated_people;
create policy "Users can create their generated people"
on public.generated_people for insert
to authenticated
with check ((select auth.uid()) = user_id);

drop policy if exists "Users can update their generated people" on public.generated_people;
create policy "Users can update their generated people"
on public.generated_people for update
to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

drop policy if exists "Users can delete their generated people" on public.generated_people;
create policy "Users can delete their generated people"
on public.generated_people for delete
to authenticated
using ((select auth.uid()) = user_id);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('moa-people', 'moa-people', false, 5242880, array['image/jpeg'])
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Users can read their generated people images" on storage.objects;
create policy "Users can read their generated people images"
on storage.objects for select
to authenticated
using (
  bucket_id = 'moa-people'
  and storage.foldername(name) = array[(select auth.uid())::text]
);

drop policy if exists "Users can upload their generated people images" on storage.objects;
create policy "Users can upload their generated people images"
on storage.objects for insert
to authenticated
with check (
  bucket_id = 'moa-people'
  and storage.foldername(name) = array[(select auth.uid())::text]
  and storage.filename(name) ~ '^[A-Za-z0-9][A-Za-z0-9._-]*\.jpg$'
);

drop policy if exists "Users can delete their generated people images" on storage.objects;
create policy "Users can delete their generated people images"
on storage.objects for delete
to authenticated
using (
  bucket_id = 'moa-people'
  and storage.foldername(name) = array[(select auth.uid())::text]
);
