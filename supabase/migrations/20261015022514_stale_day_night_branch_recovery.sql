-- A removed time palette must not prevent copying an otherwise valid session.
BEGIN;
CREATE OR REPLACE FUNCTION public.guard_session_theme_period()
RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$
BEGIN
  IF NOT NEW.theme_day_night_enabled OR NEW.theme_override IS NOT NULL OR NEW.theme_id IS NULL THEN
    NEW.theme_period:=NULL;
  ELSIF NEW.theme_period IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.themes t WHERE t.id=NEW.theme_id AND t.work_id=NEW.work_id
      AND t.day_night_enabled AND t.dark_colors IS NOT NULL AND t.light_colors IS NOT NULL
  ) THEN
    -- Old clients may still copy a cached period after the theme was edited.
    -- Drop only the unavailable time override, preserving the branch and palette.
    NEW.theme_period:=NULL;
  END IF;
  RETURN NEW;
END; $$;

UPDATE public.sessions s SET theme_period=NULL
WHERE s.theme_period IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM public.themes t WHERE t.id=s.theme_id AND t.work_id=s.work_id
    AND t.day_night_enabled AND t.dark_colors IS NOT NULL AND t.light_colors IS NOT NULL
);
COMMIT;
