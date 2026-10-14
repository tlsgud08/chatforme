-- Read-only aggregation. Keep tables, existing data and RLS policies unchanged.
create or replace function public.session_conversation_counts(target_session_ids uuid[])
returns table (session_id uuid, conversation_count bigint)
language sql
stable
security invoker
set search_path = ''
as $$
  select s.id, count(m.id)
  from public.sessions s
  left join public.messages m
    on m.session_id = s.id
    and m.role = 'assistant'
    and m.is_hidden = false
    and m.is_active_variant = true
    and m.turn_index > 0
  where s.id = any(target_session_ids)
  group by s.id;
$$;

revoke all on function public.session_conversation_counts(uuid[]) from public;
revoke all on function public.session_conversation_counts(uuid[]) from anon;
grant execute on function public.session_conversation_counts(uuid[]) to authenticated;
