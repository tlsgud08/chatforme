-- Add the new bounds without scanning legacy rows first. This makes the migration
-- safe even when an installation contains values that predate the UI ranges.
alter table public.profiles
  drop constraint if exists profiles_default_temperature_check,
  drop constraint if exists profiles_default_frequency_penalty_check,
  add constraint profiles_default_temperature_check check (default_temperature between 0.8::real and 1.2::real) not valid,
  add constraint profiles_default_frequency_penalty_check check (default_frequency_penalty between 0::real and 0.5::real) not valid;

alter table public.sessions
  drop constraint if exists sessions_temperature_override_check,
  drop constraint if exists sessions_frequency_penalty_override_check,
  add constraint sessions_temperature_override_check check (temperature_override between 0.8::real and 1.2::real) not valid,
  add constraint sessions_frequency_penalty_override_check check (frequency_penalty_override between 0::real and 0.5::real) not valid;

-- These columns are float4 (`real`), so every boundary is explicitly cast to
-- real. Without the cast, a stored float4 value displayed as 1.2 can compare
-- slightly greater than a higher-precision numeric 1.2 and fail the check.
-- Normalize every finite or non-finite legacy value. CASE is intentional here:
-- unlike greatest/least, it also turns PostgreSQL's special NaN value into a
-- valid upper bound instead of allowing it to survive the cleanup.
update public.profiles
set default_temperature = case
      when default_temperature between 0.8::real and 1.2::real then default_temperature
      when default_temperature < 0.8::real then 0.8::real
      else 1.2::real
    end,
    default_frequency_penalty = case
      when default_frequency_penalty between 0::real and 0.5::real then default_frequency_penalty
      when default_frequency_penalty < 0::real then 0::real
      else 0.5::real
    end;

update public.sessions
set temperature_override = case
      when temperature_override is null then null
      when temperature_override between 0.8::real and 1.2::real then temperature_override
      when temperature_override < 0.8::real then 0.8::real
      else 1.2::real
    end,
    frequency_penalty_override = case
      when frequency_penalty_override is null then null
      when frequency_penalty_override between 0::real and 0.5::real then frequency_penalty_override
      when frequency_penalty_override < 0::real then 0::real
      else 0.5::real
    end
where temperature_override is not null or frequency_penalty_override is not null;

-- Only mark the constraints valid after all existing rows have been repaired.
alter table public.profiles
  validate constraint profiles_default_temperature_check,
  validate constraint profiles_default_frequency_penalty_check;

alter table public.sessions
  validate constraint sessions_temperature_override_check,
  validate constraint sessions_frequency_penalty_override_check;
