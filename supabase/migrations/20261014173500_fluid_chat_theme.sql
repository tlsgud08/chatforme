-- Keep the visible scene in sessions.theme_id/theme_variant when the selection is fluid.
-- The selection tab is indicated exclusively by theme_override (NULL means 유동적).
BEGIN;

CREATE OR REPLACE FUNCTION public.validate_theme_reference()
RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$
DECLARE linked public.themes%ROWTYPE;
BEGIN
  IF TG_TABLE_NAME='works' THEN
    IF NEW.default_theme_id IS NULL THEN NEW.default_theme_variant:=NULL; RETURN NEW; END IF;
    SELECT * INTO linked FROM public.themes WHERE id=NEW.default_theme_id;
    IF NOT FOUND OR (linked.work_id IS NOT NULL AND (linked.work_id<>NEW.id OR NOT linked.work_shared))
      OR (linked.work_id IS NULL AND NOT linked.is_published) THEN
      RAISE EXCEPTION 'Theme is not available to this work';
    END IF;
  ELSIF TG_TABLE_NAME='sessions' THEN
    IF NEW.theme_override='builtin' THEN
      NEW.theme_id:=NULL;
      RETURN NEW;
    END IF;
    IF NEW.theme_override='custom' AND NEW.theme_id IS NULL THEN
      -- Preserve old deletion recovery: deleted fixed custom themes return to fluid.
      IF TG_OP='UPDATE' AND OLD.theme_id IS NOT NULL THEN
        NEW.theme_override:=NULL;
        NEW.theme_variant:=NULL;
        RETURN NEW;
      END IF;
      RAISE EXCEPTION 'Custom theme requires theme_id';
    END IF;
    -- For fluid sessions, id/variant now store the displayed scene independently.
    IF NEW.theme_id IS NULL THEN RETURN NEW; END IF;
    SELECT * INTO linked FROM public.themes WHERE id=NEW.theme_id;
    IF NOT FOUND OR (linked.work_id IS NOT NULL AND (linked.work_id<>NEW.work_id
      OR (NOT linked.work_shared AND linked.owner_id<>NEW.user_id)))
      OR (linked.work_id IS NULL AND NOT (linked.is_published OR linked.owner_id=NEW.user_id)) THEN
      RAISE EXCEPTION 'Theme is not available to this session';
    END IF;
  END IF;
  RETURN NEW;
END; $$;

-- Older clients might have left automation ON for a manually fixed theme.
-- Keep the existing manually chosen theme and disable automation instead.
UPDATE public.sessions SET auto_theme_enabled=false
  WHERE auto_theme_enabled=true AND theme_override IS NOT NULL;
ALTER TABLE public.sessions DROP CONSTRAINT IF EXISTS sessions_auto_theme_fluid_only;
ALTER TABLE public.sessions ADD CONSTRAINT sessions_auto_theme_fluid_only
  CHECK (NOT auto_theme_enabled OR theme_override IS NULL);

-- Global light/dark changes must update the *variant* of existing fluid scenes,
-- without resetting their scene/palette IDs or touching fixed themes.
CREATE OR REPLACE FUNCTION public.sync_fluid_theme_variant()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE selected text;
BEGIN
  selected:=CASE WHEN NEW.preferred_theme_mode IN ('light','dark')
    THEN NEW.preferred_theme_mode ELSE NEW.preferred_theme_variant END;
  UPDATE public.sessions
  SET theme_variant=selected
  WHERE user_id=NEW.id AND theme_override IS NULL
    AND (theme_id IS NOT NULL OR theme_variant IS NOT NULL)
    AND theme_variant IS DISTINCT FROM selected;
  RETURN NULL;
END; $$;
DROP TRIGGER IF EXISTS profiles_sync_fluid_theme_variant ON public.profiles;
CREATE TRIGGER profiles_sync_fluid_theme_variant
AFTER UPDATE OF preferred_theme_mode,preferred_theme_variant ON public.profiles
FOR EACH ROW EXECUTE FUNCTION public.sync_fluid_theme_variant();

COMMIT;
