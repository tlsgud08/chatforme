-- 0040: Follow-up integrity fixes for the 0039 theme/command rollout.
-- Apply ONCE after 0039. This migration preserves all existing records.
BEGIN;

-- Commands are unique per personal catalog OR per work, not across all works
-- owned by the same creator. Also allows a work editor's commands to share
-- names with another editor's personal commands.
ALTER TABLE public.commands DROP CONSTRAINT IF EXISTS commands_owner_id_name_key;
CREATE UNIQUE INDEX IF NOT EXISTS commands_personal_name_unique
  ON public.commands(owner_id, name) WHERE work_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS commands_work_name_unique
  ON public.commands(work_id, name) WHERE work_id IS NOT NULL;

-- Prevent work-scoped resources from being moved into an unrestricted personal
-- catalog (or reassigned to a different work/owner) using direct REST updates.
CREATE OR REPLACE FUNCTION public.keep_scoped_asset_identity()
RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$
BEGIN
  IF NEW.owner_id IS DISTINCT FROM OLD.owner_id
    OR NEW.work_id IS DISTINCT FROM OLD.work_id THEN
    RAISE EXCEPTION 'Theme/command ownership and work scope cannot be changed';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER themes_keep_scope BEFORE UPDATE ON public.themes
  FOR EACH ROW EXECUTE FUNCTION public.keep_scoped_asset_identity();
CREATE TRIGGER commands_keep_scope BEFORE UPDATE ON public.commands
  FOR EACH ROW EXECUTE FUNCTION public.keep_scoped_asset_identity();

-- An owned work-only theme cannot become a user's global preference even if
-- someone bypasses the theme picker. Users may select their own unpublished
-- PERSONAL themes or global published themes, but never a work-local theme.
CREATE OR REPLACE FUNCTION public.validate_profile_theme_choice()
RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$
DECLARE chosen public.themes%ROWTYPE;
BEGIN
  IF NEW.preferred_theme_id IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO chosen FROM public.themes WHERE id=NEW.preferred_theme_id;
  IF NOT FOUND OR chosen.work_id IS NOT NULL
    OR NOT (chosen.owner_id=NEW.id OR chosen.is_published) THEN
    RAISE EXCEPTION 'Personal default theme must be personal or published';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER profiles_theme_scope_guard
  BEFORE INSERT OR UPDATE OF preferred_theme_id ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.validate_profile_theme_choice();

-- Accept only independently specified 4-color HEX palettes.
CREATE OR REPLACE FUNCTION public.valid_theme_palette(p jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=public AS $$
SELECT CASE WHEN p IS NULL THEN true ELSE COALESCE(
  jsonb_typeof(p)='object'
  AND (p->>'accent') ~ '^#[0-9A-Fa-f]{6}$'
  AND (p->>'accentText') ~ '^#[0-9A-Fa-f]{6}$'
  AND (p->>'main') ~ '^#[0-9A-Fa-f]{6}$'
  AND (p->>'mainText') ~ '^#[0-9A-Fa-f]{6}$'
, false) END
$$;
ALTER TABLE public.themes ADD CONSTRAINT theme_dark_colors_valid
  CHECK (public.valid_theme_palette(dark_colors));
ALTER TABLE public.themes ADD CONSTRAINT theme_light_colors_valid
  CHECK (public.valid_theme_palette(light_colors));

-- Deleting a theme referenced by sessions uses ON DELETE SET NULL.
-- The original guard rejected custom+NULL, preventing deletion. Reset those
-- sessions to "inherit" when a formerly selected theme is cleared.
CREATE OR REPLACE FUNCTION public.validate_theme_reference()
RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$
DECLARE linked public.themes%ROWTYPE;
BEGIN
  IF TG_TABLE_NAME='works' THEN
    IF NEW.default_theme_id IS NULL THEN
      NEW.default_theme_variant:=NULL;
      RETURN NEW;
    END IF;
    SELECT * INTO linked FROM public.themes WHERE id=NEW.default_theme_id;
    IF NOT FOUND OR (linked.work_id IS DISTINCT FROM NEW.id AND
      (linked.work_id IS NOT NULL OR NOT linked.is_published)) THEN
      RAISE EXCEPTION 'Theme is not available to this work';
    END IF;
  ELSIF TG_TABLE_NAME='sessions' THEN
    IF NEW.theme_override IS NULL THEN
      NEW.theme_id:=NULL; NEW.theme_variant:=NULL; RETURN NEW;
    END IF;
    IF NEW.theme_override='builtin' THEN
      NEW.theme_id:=NULL; RETURN NEW;
    END IF;
    IF NEW.theme_id IS NULL THEN
      IF TG_OP='UPDATE' AND OLD.theme_id IS NOT NULL THEN
        NEW.theme_override:=NULL;
        NEW.theme_variant:=NULL;
        RETURN NEW;
      END IF;
      RAISE EXCEPTION 'Custom theme requires theme_id';
    END IF;
    SELECT * INTO linked FROM public.themes WHERE id=NEW.theme_id;
    IF NOT FOUND OR (linked.work_id IS DISTINCT FROM NEW.work_id AND
      (linked.work_id IS NOT NULL OR NOT (linked.is_published OR linked.owner_id=auth.uid()))) THEN
      RAISE EXCEPTION 'Theme is not available to this session';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

COMMIT;
