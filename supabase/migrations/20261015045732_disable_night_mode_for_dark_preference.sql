-- Dark preference turns time switching OFF, including settings changed on another device.
BEGIN;

-- Preserve the existing trigger's owner-scoped account sync and privileges.
CREATE OR REPLACE FUNCTION public.sync_fluid_theme_variant()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE selected text; previous text; reset_time boolean;
BEGIN
  selected:=CASE WHEN NEW.preferred_theme_mode IN ('light','dark')
    THEN NEW.preferred_theme_mode ELSE NEW.preferred_theme_variant END;
  previous:=CASE WHEN OLD.preferred_theme_mode IN ('light','dark')
    THEN OLD.preferred_theme_mode ELSE OLD.preferred_theme_variant END;
  -- Returning from dark must never restore a stale ON value from another client.
  reset_time:=selected='dark' OR previous='dark';
  UPDATE public.sessions
  SET theme_variant=CASE WHEN theme_override IS NULL AND (theme_id IS NOT NULL OR theme_variant IS NOT NULL)
        THEN selected ELSE theme_variant END,
      theme_day_night_enabled=CASE WHEN reset_time THEN false ELSE theme_day_night_enabled END,
      theme_period=CASE WHEN reset_time THEN NULL ELSE theme_period END
  WHERE user_id=NEW.id AND (
    (theme_override IS NULL AND (theme_id IS NOT NULL OR theme_variant IS NOT NULL)
      AND theme_variant IS DISTINCT FROM selected)
    OR (reset_time AND (theme_day_night_enabled OR theme_period IS NOT NULL))
  );
  RETURN NULL;
END; $$;

CREATE OR REPLACE FUNCTION public.guard_session_theme_period()
RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$
BEGIN
  -- An old client or cached branch cannot enable time mode under dark preference.
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
      AND t.dark_colors IS NOT NULL AND t.light_colors IS NOT NULL
  ) THEN
    NEW.theme_period:=NULL;
  END IF;
  RETURN NEW;
END; $$;

UPDATE public.sessions s SET theme_day_night_enabled=false,theme_period=NULL
FROM public.profiles p WHERE p.id=s.user_id
  AND (s.theme_day_night_enabled OR s.theme_period IS NOT NULL)
  AND CASE WHEN p.preferred_theme_mode IN ('light','dark')
    THEN p.preferred_theme_mode ELSE p.preferred_theme_variant END='dark';

COMMIT;
