-- Character goals are independent of the legacy token values; never silently
-- reinterpret a saved token budget as the same number of characters.
alter table public.profiles add column if not exists summary_narrative_target_chars text not null default '10000';
alter table public.sessions add column if not exists summary_narrative_target_chars_override text;
alter table public.summary_versions add column if not exists narrative_target_chars text;
alter table public.summary_versions add column if not exists narrative_target_enabled boolean;

-- Old clients remain usable. Re-generating a note through an old signature must
-- clear an earlier character-goal snapshot, while manual edits retain it.
do $$ declare definition text; updated text; signature text; needle text; begin
  foreach signature in array array[
    'public.save_generated_summary(uuid,text,integer,jsonb,text,integer,integer,integer,numeric)',
    'public.save_multichat_summary(uuid,text,integer,text,integer,integer,numeric)'
  ] loop
    select pg_get_functiondef(signature::regprocedure) into definition;
    if position('narrative_target_chars=null' in definition)=0 then
      needle:=case when signature like 'public.save_generated_summary%' then 'cost=excluded.cost,is_active=true;'
        else 'cost=excluded.cost;' end;
      updated:=replace(definition,needle,replace(needle,';',',narrative_target_chars=null,narrative_target_enabled=null;'));
      if updated=definition then raise exception 'Summary upsert changed; review character snapshot cleanup.'; end if;
      execute updated;
    end if;
  end loop;
  select pg_get_functiondef('public.create_session_with_start(uuid,uuid,uuid)'::regprocedure) into definition;
  if position('summary_narrative_target_chars_override' in definition)=0 then
    updated:=replace(definition,'summary_narrative_target_tokens_override,summary_source_mode_override',
      'summary_narrative_target_tokens_override,summary_narrative_target_chars_override,summary_source_mode_override');
    updated:=replace(updated,'p.summary_narrative_target_tokens,p.summary_source_mode',
      'p.summary_narrative_target_tokens,p.summary_narrative_target_chars,p.summary_source_mode');
    if updated=definition or position('p.summary_narrative_target_chars' in updated)=0 then raise exception 'Session creator changed; review character defaults.'; end if;
    execute updated;
  end if;
  select pg_get_functiondef('public.branch_session_at_message(uuid,uuid,uuid,integer)'::regprocedure) into definition;
  if position('narrative_target_chars' in definition)=0 then
    updated:=replace(definition,'is_active,input_tokens,output_tokens,cost,created_at)',
      'is_active,input_tokens,output_tokens,cost,created_at,narrative_target_chars,narrative_target_enabled)');
    updated:=replace(updated,'true,input_tokens,output_tokens,cost,created_at',
      'true,input_tokens,output_tokens,cost,created_at,narrative_target_chars,narrative_target_enabled');
    if updated=definition then raise exception 'Branch copier changed; review summary character snapshots.'; end if;
    execute updated;
  end if;
end $$;

-- Save the generation's goal atomically with its content and actual billed cost.
create or replace function public.save_generated_summary(
  target_session uuid, summary_text text, through_turn integer, source_versions jsonb,
  previous_summary text, previous_summary_turn integer, in_tokens integer,
  out_tokens integer, response_cost numeric, generation_finish_reason text,
  generation_native_finish_reason text, generation_narrative_config jsonb
) returns jsonb language plpgsql security invoker set search_path=public as $$
declare result jsonb;
begin
  if jsonb_typeof(generation_narrative_config) is distinct from 'object'
    or generation_narrative_config->>'unit' is distinct from 'characters'
    or jsonb_typeof(generation_narrative_config->'target') is distinct from 'string'
    or nullif(btrim(generation_narrative_config->>'target'),'') is null
    or jsonb_typeof(generation_narrative_config->'enabled') is distinct from 'boolean' then
    raise exception 'Invalid summary character goal' using errcode='22023';
  end if;
  result:=public.save_generated_summary(target_session,summary_text,through_turn,source_versions,
    previous_summary,previous_summary_turn,in_tokens,out_tokens,response_cost,generation_finish_reason,generation_native_finish_reason);
  update public.summary_versions set narrative_target_chars=generation_narrative_config->>'target',
    narrative_target_enabled=(generation_narrative_config->>'enabled')::boolean
  where session_id=target_session and summarized_through_turn=through_turn;
  return result;
end $$;
revoke all on function public.save_generated_summary(uuid,text,integer,jsonb,text,integer,integer,integer,numeric,text,text,jsonb) from public,anon;
grant execute on function public.save_generated_summary(uuid,text,integer,jsonb,text,integer,integer,integer,numeric,text,text,jsonb) to authenticated;

-- Match the existing protected multi-chat completion flow. PC2 can complete a
-- claimed generation; membership and the existing claim/source guards still apply.
create or replace function public.finish_multichat_summary(
  target_room uuid, request_id uuid, token uuid, summary_text text, through_turn integer,
  previous_summary text, in_tokens integer, out_tokens integer, response_cost numeric,
  source_versions jsonb, generation_finish_reason text, generation_native_finish_reason text,
  generation_narrative_config jsonb
) returns public.sessions language plpgsql security definer set search_path=public as $$
declare r public.multichat_rooms; s public.sessions; replay boolean;
begin
  select * into r from public.multichat_rooms where id=target_room for update;
  if not found or auth.uid() is null or not public.is_multichat_member(target_room) then
    raise exception '참여자가 아닙니다.' using errcode='42501';
  end if;
  if jsonb_typeof(generation_narrative_config) is distinct from 'object'
    or generation_narrative_config->>'unit' is distinct from 'characters'
    or jsonb_typeof(generation_narrative_config->'target') is distinct from 'string'
    or nullif(btrim(generation_narrative_config->>'target'),'') is null
    or jsonb_typeof(generation_narrative_config->'enabled') is distinct from 'boolean' then
    raise exception 'Invalid summary character goal' using errcode='22023';
  end if;
  replay:=r.summary_request_id is null;
  select * into s from public.finish_multichat_summary(target_room,request_id,token,summary_text,
    through_turn,previous_summary,in_tokens,out_tokens,response_cost,source_versions,generation_finish_reason,generation_native_finish_reason);
  if not replay then
    update public.summary_versions set narrative_target_chars=generation_narrative_config->>'target',
      narrative_target_enabled=(generation_narrative_config->>'enabled')::boolean
    where session_id=target_room and summarized_through_turn=through_turn;
  end if;
  return s;
end $$;
revoke all on function public.finish_multichat_summary(uuid,uuid,uuid,text,integer,text,integer,integer,numeric,jsonb,text,text,jsonb) from public,anon;
grant execute on function public.finish_multichat_summary(uuid,uuid,uuid,text,integer,text,integer,integer,numeric,jsonb,text,text,jsonb) to authenticated;
notify pgrst,'reload schema';
