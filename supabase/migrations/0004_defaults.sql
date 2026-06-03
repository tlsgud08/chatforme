-- Add is_default to personas
alter table public.personas
  add column if not exists is_default boolean not null default false;

-- Add is_default to start_configs
alter table public.start_configs
  add column if not exists is_default boolean not null default false;

-- For each user's personas, mark the first-created one as default
update public.personas p
set is_default = true
where p.created_at = (
  select min(created_at) from public.personas p2 where p2.user_id = p.user_id
);

-- For each work's start_configs, mark the first (lowest sort_order) as default
update public.start_configs sc
set is_default = true
where sc.sort_order = (
  select min(sort_order) from public.start_configs sc2 where sc2.work_id = sc.work_id
);
