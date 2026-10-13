ALTER TABLE public.sessions
  ADD COLUMN IF NOT EXISTS prompt_cache_auto_latest boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.sessions.prompt_cache_auto_latest IS
  'When explicit caching is enabled, choose the latest eligible assistant in outgoing history; otherwise cache the system only. Manual pinned ID is preserved.';
