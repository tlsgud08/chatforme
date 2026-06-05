alter table public.messages
  add column if not exists cache_read_tokens   integer not null default 0,
  add column if not exists cache_write_tokens  integer not null default 0;
