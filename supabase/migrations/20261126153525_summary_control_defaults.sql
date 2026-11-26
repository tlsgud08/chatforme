-- Defaults for new accounts. Saved account and room preferences remain explicit choices.
alter table public.profiles
  alter column summary_level set default 0,
  alter column summary_allow_omission set default false,
  alter column summary_source_mode set default 'full';
