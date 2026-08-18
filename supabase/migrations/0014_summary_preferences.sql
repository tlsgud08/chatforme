-- Global summary defaults and optional per-session overrides.
alter table public.profiles
  add column if not exists summary_model text,
  add column if not exists summary_interval int not null default 30 check (summary_interval between 5 and 200),
  add column if not exists summary_level int not null default 5 check (summary_level between 0 and 10),
  add column if not exists summary_allow_omission boolean not null default true,
  add column if not exists summary_parameters_enabled boolean not null default true,
  add column if not exists summary_extra_note text not null default '';

alter table public.sessions
  add column if not exists summary_model_override text,
  add column if not exists summary_interval_override int check (summary_interval_override between 5 and 200),
  add column if not exists summary_level_override int check (summary_level_override between 0 and 10),
  add column if not exists summary_allow_omission_override boolean,
  add column if not exists summary_parameters_enabled_override boolean;
