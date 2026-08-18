-- Persist model favorites across devices and store summary reasoning choices.
alter table public.profiles
  add column if not exists favorite_models text[] not null default '{}',
  add column if not exists summary_reasoning jsonb;

alter table public.sessions
  add column if not exists summary_reasoning_override jsonb;
