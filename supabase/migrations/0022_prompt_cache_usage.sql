-- OpenRouter prompt-cache usage reported for each assistant response.
-- NULL writes mean the provider did not report a cache-write counter.
alter table public.messages
  add column if not exists cache_read_tokens int,
  add column if not exists cache_write_tokens int;
