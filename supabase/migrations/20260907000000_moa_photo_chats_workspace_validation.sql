create or replace function public.validate_moa_workspace_projects()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_project jsonb;
  v_key text;
  v_messages jsonb;
  v_message jsonb;
  v_card_ids text[];
  v_chat_count integer;
  v_role text;
  v_content text;
begin
  if new.projects is null then
    new.projects := '[]'::jsonb;
  end if;

  if jsonb_typeof(new.projects) <> 'array' then
    raise exception 'projects must be an array' using errcode = '23514';
  end if;

  if jsonb_array_length(new.projects) > 100 then
    raise exception 'project limit exceeded' using errcode = '23514';
  end if;

  for v_project in select value from jsonb_array_elements(new.projects) loop
    if jsonb_typeof(v_project) <> 'object' then
      raise exception 'project must be an object' using errcode = '23514';
    end if;

    if v_project ? 'photoChats' then
      if jsonb_typeof(v_project->'photoChats') <> 'object' then
        raise exception 'photoChats must be an object' using errcode = '23514';
      end if;

      select count(*)
      into v_chat_count
      from jsonb_object_keys(v_project->'photoChats');

      if v_chat_count > 10 then
        raise exception 'photoChats card limit exceeded' using errcode = '23514';
      end if;

      if jsonb_typeof(v_project->'pack') = 'object'
        and jsonb_typeof(v_project->'pack'->'cards') = 'array'
      then
        select array_agg(card->>'id')
        into v_card_ids
        from jsonb_array_elements(v_project->'pack'->'cards') as card
        where card ? 'id';
      else
        v_card_ids := array[]::text[];
      end if;

      for v_key, v_messages in select key, value from jsonb_each(v_project->'photoChats') loop
        if coalesce(v_key, '') = ''
          or length(v_key) > 120
          or not (v_key = any(coalesce(v_card_ids, array[]::text[])))
        then
          raise exception 'photoChats key must match a card id' using errcode = '23514';
        end if;

        if jsonb_typeof(v_messages) <> 'array' then
          raise exception 'photoChats messages must be an array' using errcode = '23514';
        end if;

        if jsonb_array_length(v_messages) > 200 then
          raise exception 'photoChats message limit exceeded' using errcode = '23514';
        end if;

        for v_message in select value from jsonb_array_elements(v_messages) loop
          if jsonb_typeof(v_message) <> 'object'
            or not (v_message ? 'role')
            or not (v_message ? 'content')
            or (select count(*) from jsonb_object_keys(v_message)) <> 2
          then
            raise exception 'photoChats messages must contain only role and content' using errcode = '23514';
          end if;

          if jsonb_typeof(v_message->'role') <> 'string' then
            raise exception 'photoChats role must be text' using errcode = '23514';
          end if;

          v_role := v_message->>'role';
          if coalesce(v_role, '') not in ('user', 'assistant') then
            raise exception 'photoChats role is invalid' using errcode = '23514';
          end if;

          if jsonb_typeof(v_message->'content') <> 'string' then
            raise exception 'photoChats content must be text' using errcode = '23514';
          end if;

          v_content := v_message->>'content';
          if length(v_content) < 1
            or (v_role = 'user' and length(v_content) > 2000)
            or (v_role = 'assistant' and length(v_content) > 4000)
          then
            raise exception 'photoChats content length is invalid' using errcode = '23514';
          end if;
        end loop;
      end loop;
    end if;
  end loop;

  return new;
end;
$$;

drop trigger if exists validate_moa_workspace_projects on public.workspaces;
create trigger validate_moa_workspace_projects
before insert or update of projects on public.workspaces
for each row execute function public.validate_moa_workspace_projects();

revoke all on function public.validate_moa_workspace_projects() from public;
revoke all on function public.validate_moa_workspace_projects() from anon;
grant execute on function public.validate_moa_workspace_projects() to authenticated, service_role;
