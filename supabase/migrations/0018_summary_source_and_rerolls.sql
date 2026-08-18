-- Summary input strategy and non-destructive assistant response rerolls.
alter table public.profiles
  add column if not exists summary_source_mode text not null default 'incremental'
    check (summary_source_mode in ('incremental', 'full'));

alter table public.sessions
  add column if not exists summary_source_mode_override text
    check (summary_source_mode_override in ('incremental', 'full'));

alter table public.messages
  add column if not exists reroll_group_id uuid,
  add column if not exists reroll_index int not null default 1 check (reroll_index >= 1),
  add column if not exists is_active_variant boolean not null default true;

create index if not exists messages_reroll_group_idx
  on public.messages(session_id, reroll_group_id, reroll_index);
