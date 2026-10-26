-- Same definition as the room's totalUserTurns. No message/summary rewrites.
create or replace function public.session_conversation_counts(target_session_ids uuid[])
returns table (session_id uuid, conversation_count bigint)
language sql stable security invoker set search_path = ''
as $$
  select s.id, count(m.id)
  from public.sessions s
  left join public.messages m on m.session_id=s.id
    and m.role='user' and not m.is_hidden and m.is_active_variant
  where s.id=any(target_session_ids) and s.user_id=(select auth.uid())
  group by s.id;
$$;
revoke all on function public.session_conversation_counts(uuid[]) from public,anon;
grant execute on function public.session_conversation_counts(uuid[]) to authenticated;
notify pgrst, 'reload schema';
