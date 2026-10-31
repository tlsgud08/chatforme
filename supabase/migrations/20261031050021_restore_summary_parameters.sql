-- Restore the original user/room controls without restoring personal prompt overrides.
-- The columns, defaults, bounds and ownership policies already exist.
drop trigger if exists retire_room_summary_settings on public.sessions;

create or replace function public.retire_personal_summary_settings() returns trigger
language plpgsql security invoker set search_path=public as $$
begin
  new.summary_prompt:=null;
  return new;
end $$;
revoke all on function public.retire_personal_summary_settings() from public,anon,authenticated;

-- Restore the original snapshot of personal defaults for newly created rooms.
-- Read the current definition to retain all unrelated creation/ownership behavior.
do $$ declare definition text; original text; begin
  select pg_get_functiondef('public.create_session_with_start(uuid,uuid,uuid)'::regprocedure) into definition;
  if position('summary_level_override' in definition)=0 then
    original:=definition;
    definition:=replace(definition,'summary_reasoning_override,summary_source_mode_override',
      'summary_reasoning_override,summary_level_override,summary_allow_omission_override,summary_parameters_enabled_override,summary_source_mode_override');
    definition:=replace(definition,'p.summary_reasoning,p.summary_source_mode',
      'p.summary_reasoning,p.summary_level,p.summary_allow_omission,p.summary_parameters_enabled,p.summary_source_mode');
    if definition=original or position('p.summary_level' in definition)=0 then
      raise exception 'Session creator changed; summary defaults must be restored explicitly.';
    end if;
    execute definition;
  end if;
end $$;

-- Do not reset or rewrite any saved preferences, prompts, notes or archives.
notify pgrst,'reload schema';
