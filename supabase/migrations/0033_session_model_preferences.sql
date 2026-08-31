-- Keep generation preferences with each chat room. The browser cache remains a
-- migration/offline fallback, while these columns make the selection durable
-- across navigation, devices, and cleared browser storage.
alter table public.sessions
  add column if not exists model_override text,
  add column if not exists reasoning_override jsonb;
