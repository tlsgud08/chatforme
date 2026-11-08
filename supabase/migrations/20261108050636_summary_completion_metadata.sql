-- Keep saved preferences and room overrides intact; only new profile defaults change.
alter table public.profiles alter column summary_level set default 0;
alter table public.profiles alter column summary_allow_omission set default false;

alter table public.summary_versions
  add column finish_reason text,
  add column native_finish_reason text;

-- Retain the original signatures for old clients. These overloads save the body,
-- usage and termination metadata in the same transaction with the same guards.
create function public.save_generated_summary(
  target_session uuid, summary_text text, through_turn integer, source_versions jsonb,
  previous_summary text, previous_summary_turn integer, in_tokens integer,
  out_tokens integer, response_cost numeric, generation_finish_reason text,
  generation_native_finish_reason text
) returns jsonb language plpgsql security invoker set search_path=public as $$
declare result jsonb;
begin
  result:=public.save_generated_summary(target_session,summary_text,through_turn,source_versions,
    previous_summary,previous_summary_turn,in_tokens,out_tokens,response_cost);
  update public.summary_versions set finish_reason=generation_finish_reason,
    native_finish_reason=generation_native_finish_reason
  where session_id=target_session and summarized_through_turn=through_turn;
  return result;
end $$;
revoke all on function public.save_generated_summary(uuid,text,integer,jsonb,text,integer,integer,integer,numeric,text,text) from public,anon;
grant execute on function public.save_generated_summary(uuid,text,integer,jsonb,text,integer,integer,integer,numeric,text,text) to authenticated;

create function public.finish_multichat_summary(
  target_room uuid, request_id uuid, token uuid, summary_text text, through_turn integer,
  previous_summary text, in_tokens integer, out_tokens integer, response_cost numeric,
  source_versions jsonb, generation_finish_reason text, generation_native_finish_reason text
) returns public.sessions language plpgsql security definer set search_path=public as $$
declare r public.multichat_rooms; s public.sessions; replay boolean;
begin
  select * into r from public.multichat_rooms where id=target_room for update;
  if not found or auth.uid() is null or not public.is_multichat_member(target_room) then
    raise exception '참여자가 아닙니다.' using errcode='42501';
  end if;
  replay:=r.summary_request_id is null;
  select * into s from public.finish_multichat_summary(target_room,request_id,token,summary_text,
    through_turn,previous_summary,in_tokens,out_tokens,response_cost,source_versions);
  -- An acknowledgement replay must not rewrite metadata on a later summary.
  if not replay then
    update public.summary_versions set finish_reason=generation_finish_reason,
      native_finish_reason=generation_native_finish_reason
    where session_id=target_room and summarized_through_turn=through_turn;
  end if;
  return s;
end $$;
revoke all on function public.finish_multichat_summary(uuid,uuid,uuid,text,integer,text,integer,integer,numeric,jsonb,text,text) from public,anon;
grant execute on function public.finish_multichat_summary(uuid,uuid,uuid,text,integer,text,integer,integer,numeric,jsonb,text,text) to authenticated;

-- Sync snapshots already use JSON, so preserve metadata without changing the API.
do $$ declare definition text; updated text; needle text; begin
  select pg_get_functiondef('private.semi_session_action(text,uuid,uuid,uuid,jsonb)'::regprocedure) into definition;
  needle:='''through_turn'',details->''through_turn'');';
  updated:=replace(definition,needle,
    '''through_turn'',details->''through_turn'',''finish_reason'',details->>''generation_finish_reason'',''native_finish_reason'',details->>''generation_native_finish_reason'');');
  if updated=definition then raise exception 'Sync snapshot creation changed; termination metadata must be added explicitly.'; end if;
  execute updated;
end $$;
notify pgrst,'reload schema';
