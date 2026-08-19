-- A start configuration may be selected by existing sessions. Deleting the
-- configuration should remove the reference, rather than being rejected by the
-- implicit NO ACTION foreign key and leaving the UI with an apparent deletion.
alter table public.sessions
  drop constraint if exists sessions_start_config_id_fkey;

alter table public.sessions
  add constraint sessions_start_config_id_fkey
  foreign key (start_config_id)
  references public.start_configs(id)
  on delete set null;

-- Keep the intended ownership graph explicit and self-documenting. These
-- cascades remove every session child when a chat room or work is deleted.
alter table public.messages
  drop constraint if exists messages_session_id_fkey;
alter table public.messages
  add constraint messages_session_id_fkey
  foreign key (session_id) references public.sessions(id) on delete cascade;

alter table public.summary_versions
  drop constraint if exists summary_versions_session_id_fkey;
alter table public.summary_versions
  add constraint summary_versions_session_id_fkey
  foreign key (session_id) references public.sessions(id) on delete cascade;

alter table public.story_notes
  drop constraint if exists story_notes_session_id_fkey;
alter table public.story_notes
  add constraint story_notes_session_id_fkey
  foreign key (session_id) references public.sessions(id) on delete cascade;
