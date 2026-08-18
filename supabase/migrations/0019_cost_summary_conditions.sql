-- Optional cost gate for automatic summaries. Existing and new accounts stay off.
alter table public.profiles
  add column if not exists summary_cost_enabled boolean not null default false,
  add column if not exists summary_cost_currency text not null default 'USD' check (summary_cost_currency in ('USD', 'KRW')),
  add column if not exists summary_cost_threshold numeric not null default 0 check (summary_cost_threshold >= 0);

alter table public.sessions
  alter column auto_summary_enabled set default false,
  add column if not exists summary_cost_enabled_override boolean,
  add column if not exists summary_cost_currency_override text check (summary_cost_currency_override in ('USD', 'KRW')),
  add column if not exists summary_cost_threshold_override numeric check (summary_cost_threshold_override >= 0);

update public.sessions set auto_summary_enabled = false where auto_summary_enabled is null;
