alter table public.profiles
  add column image_cache_max_entries integer not null default 1000 check (image_cache_max_entries between 1 and 10000),
  add column image_cache_max_age_days integer default null check (image_cache_max_age_days is null or image_cache_max_age_days between 1 and 3650);
