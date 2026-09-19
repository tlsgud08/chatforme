-- Sampling controls belong to profiles by default and can be overridden per room.
alter table public.profiles alter column default_output_tokens set default 8000;
update public.profiles set default_output_tokens = 8000 where default_output_tokens = 1024;

alter table public.profiles
  add column if not exists default_temperature real not null default 1 check (default_temperature between 0 and 2),
  add column if not exists default_temperature_enabled boolean not null default false,
  add column if not exists default_frequency_penalty real not null default 0 check (default_frequency_penalty between -2 and 2),
  add column if not exists default_frequency_penalty_enabled boolean not null default false,
  add column if not exists default_reasoning_enabled boolean not null default true,
  add column if not exists default_reasoning jsonb;

alter table public.sessions
  add column if not exists output_settings_override_enabled boolean not null default false,
  add column if not exists temperature_override real check (temperature_override between 0 and 2),
  add column if not exists temperature_enabled_override boolean,
  add column if not exists frequency_penalty_override real check (frequency_penalty_override between -2 and 2),
  add column if not exists frequency_penalty_enabled_override boolean;

update public.sessions set output_settings_override_enabled = true
where output_tokens_override is not null or reasoning_override is not null;
