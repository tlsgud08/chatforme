-- Existing session ownership/RLS policies also protect these settings.
ALTER TABLE public.sessions
  ADD COLUMN IF NOT EXISTS prompt_cache_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS prompt_cache_message_id uuid;

-- Intentionally no ON DELETE SET NULL: deleting a selected answer must not
-- silently change its boundary to system-only. Missing targets suspend the marker.
COMMENT ON COLUMN public.sessions.prompt_cache_message_id IS
  'Pinned assistant message ID for explicit caching; NULL means system-only. Validate against the outgoing session history.';
