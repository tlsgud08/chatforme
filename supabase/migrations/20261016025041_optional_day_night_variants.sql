-- Independent from day_night_enabled, which controls catalog availability only.
BEGIN;

ALTER TABLE public.themes
  ADD COLUMN IF NOT EXISTS use_day_night_variants boolean NOT NULL DEFAULT true;
COMMENT ON COLUMN public.themes.use_day_night_variants IS
  'Split dual work themes into day/night AI choices; false uses the global light/dark preference in fluid mode';

CREATE OR REPLACE FUNCTION public.guard_session_theme_period()
RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$
BEGIN
  IF NEW.theme_day_night_enabled AND EXISTS (
    SELECT 1 FROM public.profiles p WHERE p.id=NEW.user_id AND
      CASE WHEN p.preferred_theme_mode IN ('light','dark')
        THEN p.preferred_theme_mode ELSE p.preferred_theme_variant END='dark'
  ) THEN
    NEW.theme_day_night_enabled:=false;
  END IF;
  IF NOT NEW.theme_day_night_enabled OR NEW.theme_override IS NOT NULL OR NEW.theme_id IS NULL THEN
    NEW.theme_period:=NULL;
  ELSIF NEW.theme_period IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.themes t WHERE t.id=NEW.theme_id AND t.work_id=NEW.work_id
      AND t.use_day_night_variants AND t.dark_colors IS NOT NULL AND t.light_colors IS NOT NULL
  ) THEN
    -- A cached client/branch must not restore a period after this theme opts out.
    NEW.theme_period:=NULL;
  END IF;
  RETURN NEW;
END; $$;

COMMIT;
