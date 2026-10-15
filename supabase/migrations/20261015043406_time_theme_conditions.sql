-- The theme checkbox is availability only; every dual work theme supports time switching.
BEGIN;

ALTER TABLE public.themes DROP CONSTRAINT IF EXISTS theme_day_night_requires_work_dual;
ALTER TABLE public.themes ADD CONSTRAINT theme_day_night_requires_work
  CHECK (NOT day_night_enabled OR work_id IS NOT NULL);
COMMENT ON COLUMN public.themes.day_night_enabled IS
  'Available for automatic selection only while day/night mode is active; single and dual work themes are allowed';

CREATE OR REPLACE FUNCTION public.guard_session_theme_period()
RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$
BEGIN
  IF NOT NEW.theme_day_night_enabled OR NEW.theme_override IS NOT NULL OR NEW.theme_id IS NULL THEN
    NEW.theme_period:=NULL;
  ELSIF NEW.theme_period IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.themes t WHERE t.id=NEW.theme_id AND t.work_id=NEW.work_id
      AND t.dark_colors IS NOT NULL AND t.light_colors IS NOT NULL
  ) THEN
    -- A cached branch with a now-single/deleted theme still remains valid.
    NEW.theme_period:=NULL;
  END IF;
  RETURN NEW;
END; $$;

COMMIT;
