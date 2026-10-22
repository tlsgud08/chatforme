-- Requires session_work_combination and optional_day_night_variants.
-- No records, palettes, names, or inactive combination settings are rewritten.
BEGIN;

CREATE OR REPLACE FUNCTION public.validate_theme_reference()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
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
    IF NEW.theme_override='builtin' THEN NEW.theme_id:=NULL; RETURN NEW; END IF;
    IF NEW.theme_override='custom' AND NEW.theme_id IS NULL THEN
      IF TG_OP='UPDATE' AND OLD.theme_id IS NOT NULL THEN
        NEW.theme_override:=NULL; NEW.theme_variant:=NULL; NEW.theme_period:=NULL;
        NEW.auto_theme_enabled:=true;
        RETURN NEW;
      END IF;
      RAISE EXCEPTION 'Custom theme requires theme_id';
    END IF;
    IF NEW.theme_id IS NULL THEN RETURN NEW; END IF;
    SELECT * INTO linked FROM public.themes WHERE id=NEW.theme_id;
    IF NOT FOUND OR (linked.work_id IS NOT NULL AND (
        NOT (linked.work_id=NEW.work_id OR (
          NEW.work_combination_enabled AND linked.work_id=ANY(NEW.combined_work_ids)
          AND EXISTS (SELECT 1 FROM public.works w WHERE w.id=linked.work_id)
        )) OR (NOT linked.work_shared AND linked.owner_id<>NEW.user_id)
      )) OR (linked.work_id IS NULL AND NOT (linked.is_published OR linked.owner_id=NEW.user_id)) THEN
      -- Dropping a work (or losing access) must not trap a room on a theme
      -- that it can no longer use. Only recover an unchanged old reference;
      -- newly assigned out-of-scope IDs are always rejected.
      IF TG_OP='UPDATE' AND NEW.theme_id IS NOT DISTINCT FROM OLD.theme_id
        AND NEW.work_id IS NOT DISTINCT FROM OLD.work_id
        AND NEW.user_id IS NOT DISTINCT FROM OLD.user_id THEN
        NEW.theme_id:=NULL; NEW.theme_variant:=NULL; NEW.theme_period:=NULL;
        NEW.theme_override:=NULL; NEW.auto_theme_enabled:=true;
        -- All-null fluid selection lets the renderer honor the main work's
        -- default, then the account preference, without copying any palette.
        RETURN NEW;
      END IF;
      RAISE EXCEPTION 'Theme is not available to this session';
    END IF;
  END IF;
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS sessions_theme_guard ON public.sessions;
CREATE TRIGGER sessions_theme_guard BEFORE INSERT OR UPDATE OF
  theme_override,theme_id,theme_variant,work_id,user_id,work_combination_enabled,combined_work_ids
  ON public.sessions FOR EACH ROW EXECUTE FUNCTION public.validate_theme_reference();

CREATE OR REPLACE FUNCTION public.guard_session_theme_period()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
BEGIN
  IF NEW.theme_day_night_enabled AND EXISTS (
    SELECT 1 FROM public.profiles p WHERE p.id=NEW.user_id AND
      CASE WHEN p.preferred_theme_mode IN ('light','dark')
        THEN p.preferred_theme_mode ELSE p.preferred_theme_variant END='dark'
  ) THEN NEW.theme_day_night_enabled:=false; END IF;
  IF NOT NEW.theme_day_night_enabled OR NEW.theme_override IS NOT NULL OR NEW.theme_id IS NULL THEN
    NEW.theme_period:=NULL;
  ELSIF NEW.theme_period IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.themes t WHERE t.id=NEW.theme_id
      AND (t.work_id=NEW.work_id OR (NEW.work_combination_enabled
        AND t.work_id=ANY(NEW.combined_work_ids)
        AND EXISTS (SELECT 1 FROM public.works w WHERE w.id=t.work_id)))
      AND (t.work_shared OR t.owner_id=NEW.user_id)
      AND t.use_day_night_variants AND t.dark_colors IS NOT NULL AND t.light_colors IS NOT NULL
  ) THEN
    -- Preserve stale branch recovery and per-theme opt-out behavior.
    NEW.theme_period:=NULL;
  END IF;
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS sessions_theme_period_guard ON public.sessions;
CREATE TRIGGER sessions_theme_period_guard BEFORE INSERT OR UPDATE OF
  theme_id,theme_override,theme_day_night_enabled,theme_period,work_id,user_id,work_combination_enabled,combined_work_ids
  ON public.sessions FOR EACH ROW EXECUTE FUNCTION public.guard_session_theme_period();

REVOKE ALL ON FUNCTION public.validate_theme_reference() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_session_theme_period() FROM PUBLIC;
COMMIT;
