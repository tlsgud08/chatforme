-- Normalize legacy preferences only when creating a new chat room.
CREATE OR REPLACE FUNCTION public.create_session_with_start(target_work uuid, target_persona uuid DEFAULT NULL::uuid, target_config uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare p public.profiles; w public.works; c public.start_configs; result uuid;
begin
  select * into p from public.profiles where id=(select auth.uid());
  if not found then raise exception 'Authentication required' using errcode='42501'; end if;
  select * into w from public.works where id=target_work;
  if not found then raise exception 'Work is inaccessible' using errcode='42501'; end if;
  if target_persona is not null and not exists(select 1 from public.personas where id=target_persona and user_id=p.id) then
    raise exception 'Persona is inaccessible' using errcode='42501'; end if;
  if target_config is not null then
    select * into c from public.start_configs where id=target_config and work_id=target_work;
    if not found then raise exception 'Start configuration is inaccessible' using errcode='42501'; end if;
  end if;
  -- Older profiles were initialized with level 5 and omission enabled.
  if p.summary_level = 5 and p.summary_allow_omission then
    p.summary_level := 0;
    p.summary_allow_omission := false;
    p.summary_source_mode := 'full';
  end if;
  insert into public.sessions(user_id,work_id,title,persona_id,start_config_id,summary_model_override,
    summary_reasoning_override,summary_level_override,summary_allow_omission_override,summary_parameters_enabled_override,summary_narrative_target_tokens_override,summary_narrative_target_chars_override,summary_source_mode_override)
  values(p.id,w.id,w.title,target_persona,target_config,coalesce(nullif(p.summary_model,''),nullif(p.default_model,'')),
    p.summary_reasoning,p.summary_level,p.summary_allow_omission,p.summary_parameters_enabled,p.summary_narrative_target_tokens,p.summary_narrative_target_chars,p.summary_source_mode)
  returning id into result;
  if nullif(trim(c.initial_context),'') is not null then
    insert into public.messages(session_id,role,content,turn_index,is_hidden)
    values(result,'user',E'[시작 설정: 아래 내용을 참고해 첫 장면을 시작하세요]\n\n'||c.initial_context,0,true);
  end if;
  if nullif(trim(c.initial_message),'') is not null then
    insert into public.messages(session_id,role,content,turn_index,is_hidden)
    values(result,'assistant',c.initial_message,0,false);
  end if;
  return result;
end $function$;

CREATE OR REPLACE FUNCTION public.multichat_create_session()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare use_new_summary_defaults boolean;
begin
 select summary_level = 5 and summary_allow_omission into use_new_summary_defaults
   from public.profiles where id = new.host_user_id;
 insert into public.sessions(id,user_id,work_id,title,multichat_room_id,model_override,output_tokens_override,output_settings_override_enabled,start_config_id,
   summary_level_override,summary_allow_omission_override,summary_source_mode_override)
 values(new.id,new.host_user_id,new.work_id,new.title,new.id,new.model,new.output_tokens,new.output_tokens is not null,
   (select id from public.start_configs where work_id=new.work_id order by is_default desc,sort_order,id limit 1),
   case when use_new_summary_defaults then 0 end,
   case when use_new_summary_defaults then false end,
   case when use_new_summary_defaults then 'full' end);
 return new;
end $function$;
