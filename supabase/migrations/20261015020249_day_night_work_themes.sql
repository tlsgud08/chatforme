-- Day/night is scene state, independent from the user's light/dark preference.
BEGIN;

ALTER TABLE public.themes ADD COLUMN IF NOT EXISTS day_night_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE public.themes DROP CONSTRAINT IF EXISTS theme_day_night_requires_work_dual;
ALTER TABLE public.themes ADD CONSTRAINT theme_day_night_requires_work_dual
  CHECK (NOT day_night_enabled OR (work_id IS NOT NULL AND dark_colors IS NOT NULL AND light_colors IS NOT NULL));

ALTER TABLE public.sessions ADD COLUMN IF NOT EXISTS theme_day_night_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE public.sessions ADD COLUMN IF NOT EXISTS theme_period text;
ALTER TABLE public.sessions DROP CONSTRAINT IF EXISTS session_theme_period_valid;
ALTER TABLE public.sessions ADD CONSTRAINT session_theme_period_valid
  CHECK (theme_period IS NULL OR (theme_period IN ('day','night') AND theme_day_night_enabled AND theme_override IS NULL AND theme_id IS NOT NULL));

CREATE OR REPLACE FUNCTION public.guard_session_theme_period()
RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$
BEGIN
  -- Preserve deletion recovery and old clients switching to fixed themes.
  IF NOT NEW.theme_day_night_enabled OR NEW.theme_override IS NOT NULL OR NEW.theme_id IS NULL THEN
    NEW.theme_period:=NULL;
  ELSIF NEW.theme_period IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.themes t WHERE t.id=NEW.theme_id AND t.work_id=NEW.work_id
      AND t.day_night_enabled AND t.dark_colors IS NOT NULL AND t.light_colors IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Day/night requires an enabled dual work theme';
  END IF;
  RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS sessions_theme_period_guard ON public.sessions;
CREATE TRIGGER sessions_theme_period_guard
BEFORE INSERT OR UPDATE OF theme_id,theme_override,theme_day_night_enabled,theme_period,work_id,user_id ON public.sessions
FOR EACH ROW EXECUTE FUNCTION public.guard_session_theme_period();

COMMENT ON COLUMN public.sessions.theme_period IS 'AI scene day/night; never changes the global light/dark preference';
COMMIT;
