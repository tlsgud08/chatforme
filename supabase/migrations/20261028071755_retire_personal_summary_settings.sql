-- Keep the transactional session creator compatible with the retired fields.
do $$ declare definition text; begin
 select pg_get_functiondef('public.create_session_with_start(uuid,uuid,uuid)'::regprocedure) into definition;
 definition:=regexp_replace(definition,',summary_level_override,summary_allow_omission_override,[[:space:]]*summary_parameters_enabled_override','','g');
 definition:=replace(definition,',p.summary_level,p.summary_allow_omission,p.summary_parameters_enabled','');
 execute definition;
end $$;
-- Inert compatibility slots keep already-open clients' unrelated profile saves
-- working during deployment. They cannot store instructions or affect a summary.
update public.profiles set summary_prompt=null,summary_extra_note='',summary_level=5,summary_allow_omission=true,summary_parameters_enabled=true;
update public.sessions set summary_level_override=null,summary_allow_omission_override=null,summary_parameters_enabled_override=null;
create function public.retire_personal_summary_settings() returns trigger
language plpgsql security invoker set search_path=public as $$
begin
 if TG_TABLE_NAME='profiles' then
  new.summary_prompt:=null;new.summary_extra_note:='';new.summary_level:=5;new.summary_allow_omission:=true;new.summary_parameters_enabled:=true;
 else
  new.summary_level_override:=null;new.summary_allow_omission_override:=null;new.summary_parameters_enabled_override:=null;
 end if;
 return new;
end $$;
revoke all on function public.retire_personal_summary_settings() from public,anon,authenticated;
create trigger retire_personal_summary_settings before insert or update on public.profiles for each row execute function public.retire_personal_summary_settings();
create trigger retire_room_summary_settings before insert or update on public.sessions for each row execute function public.retire_personal_summary_settings();

notify pgrst,'reload schema';
