alter table public.profiles add column summary_narrative_target_tokens text not null default '3000';
alter table public.sessions add column summary_narrative_target_tokens_override text;

-- Snapshot the personal text default for new rooms, preserving existing settings and archives.
do $$ declare definition text; updated text; begin
  select pg_get_functiondef('public.create_session_with_start(uuid,uuid,uuid)'::regprocedure) into definition;
  updated:=replace(definition,'summary_parameters_enabled_override,summary_source_mode_override',
    'summary_parameters_enabled_override,summary_narrative_target_tokens_override,summary_source_mode_override');
  updated:=replace(updated,'p.summary_parameters_enabled,p.summary_source_mode',
    'p.summary_parameters_enabled,p.summary_narrative_target_tokens,p.summary_source_mode');
  if updated=definition or position('p.summary_narrative_target_tokens' in updated)=0 then
    raise exception 'Session creator changed; narrative target defaults must be added explicitly.';
  end if;
  execute updated;
end $$;
notify pgrst,'reload schema';
