create table if not exists public.photo_chat_history (
  user_id uuid not null references auth.users(id) on delete cascade,
  conversation_id text not null,
  messages jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (user_id, conversation_id),
  constraint photo_chat_history_conversation_id_check check (
    length(conversation_id) between 1 and 120
  )
);

create index if not exists photo_chat_history_user_updated_idx
on public.photo_chat_history (user_id, updated_at desc);

create or replace function public.validate_photo_chat_history()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_message jsonb;
  v_role text;
  v_content text;
begin
  if new.messages is null then
    new.messages := '[]'::jsonb;
  end if;

  if jsonb_typeof(new.messages) <> 'array' then
    raise exception 'messages must be an array' using errcode = '23514';
  end if;

  if jsonb_array_length(new.messages) > 200 then
    raise exception 'message limit exceeded' using errcode = '23514';
  end if;

  for v_message in select value from jsonb_array_elements(new.messages) loop
    if jsonb_typeof(v_message) <> 'object'
      or not (v_message ? 'role')
      or not (v_message ? 'content')
      or (select count(*) from jsonb_object_keys(v_message)) <> 2
    then
      raise exception 'messages must contain only role and content' using errcode = '23514';
    end if;

    if jsonb_typeof(v_message->'role') <> 'string' then
      raise exception 'message role must be text' using errcode = '23514';
    end if;

    v_role := v_message->>'role';
    if coalesce(v_role, '') not in ('user', 'assistant') then
      raise exception 'message role is invalid' using errcode = '23514';
    end if;

    if jsonb_typeof(v_message->'content') <> 'string' then
      raise exception 'message content must be text' using errcode = '23514';
    end if;

    v_content := v_message->>'content';
    if (v_role = 'user' and length(v_content) > 2000)
      or (v_role = 'assistant' and length(v_content) > 4000)
    then
      raise exception 'message content length is invalid' using errcode = '23514';
    end if;
  end loop;

  return new;
end;
$$;

drop trigger if exists validate_photo_chat_history on public.photo_chat_history;
create trigger validate_photo_chat_history
before insert or update of messages on public.photo_chat_history
for each row execute function public.validate_photo_chat_history();

alter table public.photo_chat_history enable row level security;

revoke all on public.photo_chat_history from anon;
revoke all on public.photo_chat_history from authenticated;
grant select, insert, update, delete on public.photo_chat_history to authenticated;
grant all on public.photo_chat_history to service_role;

drop policy if exists "Users can read their photo chat history" on public.photo_chat_history;
create policy "Users can read their photo chat history"
on public.photo_chat_history for select
to authenticated
using ((select auth.uid()) = user_id);

drop policy if exists "Users can create their photo chat history" on public.photo_chat_history;
create policy "Users can create their photo chat history"
on public.photo_chat_history for insert
to authenticated
with check ((select auth.uid()) = user_id);

drop policy if exists "Users can update their photo chat history" on public.photo_chat_history;
create policy "Users can update their photo chat history"
on public.photo_chat_history for update
to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

drop policy if exists "Users can delete their photo chat history" on public.photo_chat_history;
create policy "Users can delete their photo chat history"
on public.photo_chat_history for delete
to authenticated
using ((select auth.uid()) = user_id);

revoke all on function public.validate_photo_chat_history() from public;
revoke all on function public.validate_photo_chat_history() from anon;
grant execute on function public.validate_photo_chat_history() to authenticated, service_role;
