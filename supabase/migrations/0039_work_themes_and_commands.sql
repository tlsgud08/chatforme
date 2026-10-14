-- 0039: Account-synced palettes, work-local themes and work-local commands.
-- Apply after 0038_auto_latest_prompt_cache.sql.
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS prefer_work_theme boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS preferred_theme_mode text,
  ADD COLUMN IF NOT EXISTS preferred_theme_id uuid,
  ADD COLUMN IF NOT EXISTS preferred_theme_variant text NOT NULL DEFAULT 'light';
ALTER TABLE public.profiles ADD CONSTRAINT profile_theme_mode_valid CHECK (preferred_theme_mode IS NULL OR preferred_theme_mode IN ('dark','light','custom'));
ALTER TABLE public.profiles ADD CONSTRAINT profile_theme_variant_valid CHECK (preferred_theme_variant IN ('dark','light'));

CREATE TABLE public.themes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  work_id uuid REFERENCES public.works(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(trim(name)) BETWEEN 1 AND 80),
  description text NOT NULL DEFAULT '' CHECK (char_length(description) <= 500),
  dark_colors jsonb,
  light_colors jsonb,
  is_published boolean NOT NULL DEFAULT false,
  copied_from_id uuid REFERENCES public.themes(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT theme_has_variant CHECK (dark_colors IS NOT NULL OR light_colors IS NOT NULL),
  CONSTRAINT work_theme_not_published CHECK (work_id IS NULL OR NOT is_published)
);
CREATE INDEX themes_work_idx ON public.themes (work_id) WHERE work_id IS NOT NULL;
CREATE INDEX themes_owner_idx ON public.themes (owner_id);
CREATE INDEX themes_published_idx ON public.themes (updated_at DESC) WHERE is_published;
ALTER TABLE public.themes ENABLE ROW LEVEL SECURITY;
CREATE OR REPLACE FUNCTION public.set_theme_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN NEW.updated_at:=now(); RETURN NEW; END; $$;
CREATE TRIGGER themes_updated_at BEFORE UPDATE ON public.themes
  FOR EACH ROW EXECUTE FUNCTION public.set_theme_updated_at();
CREATE POLICY themes_read ON public.themes FOR SELECT TO public
  USING (owner_id = auth.uid() OR (work_id IS NULL AND is_published)
    OR (work_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.works w WHERE w.id=themes.work_id)));
CREATE POLICY themes_insert ON public.themes FOR INSERT TO authenticated
  WITH CHECK (owner_id = auth.uid() AND NOT is_published
    AND (work_id IS NULL OR public.can_edit_work(work_id)));
CREATE POLICY themes_update ON public.themes FOR UPDATE TO authenticated
  USING ((work_id IS NULL AND owner_id = auth.uid()) OR (work_id IS NOT NULL AND public.can_edit_work(work_id)))
  WITH CHECK ((work_id IS NULL AND owner_id = auth.uid()) OR (work_id IS NOT NULL AND public.can_edit_work(work_id)));
CREATE POLICY themes_delete ON public.themes FOR DELETE TO authenticated
  USING ((work_id IS NULL AND owner_id = auth.uid()) OR (work_id IS NOT NULL AND public.can_edit_work(work_id)));

CREATE TABLE public.theme_favorites (
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  theme_id uuid NOT NULL REFERENCES public.themes(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, theme_id)
);
ALTER TABLE public.theme_favorites ENABLE ROW LEVEL SECURITY;
CREATE POLICY theme_favorites_read ON public.theme_favorites FOR SELECT TO authenticated USING (user_id=auth.uid());
CREATE POLICY theme_favorites_write ON public.theme_favorites FOR INSERT TO authenticated
  WITH CHECK (user_id=auth.uid() AND EXISTS (
    SELECT 1 FROM public.themes t WHERE t.id=theme_id AND t.work_id IS NULL AND (t.owner_id=auth.uid() OR t.is_published)
  ));
CREATE POLICY theme_favorites_delete ON public.theme_favorites FOR DELETE TO authenticated USING (user_id=auth.uid());

ALTER TABLE public.works ADD COLUMN IF NOT EXISTS default_theme_id uuid REFERENCES public.themes(id) ON DELETE SET NULL;
ALTER TABLE public.works ADD COLUMN IF NOT EXISTS default_theme_variant text CHECK (default_theme_variant IN ('dark','light'));
ALTER TABLE public.profiles ADD CONSTRAINT preferred_theme_fk FOREIGN KEY (preferred_theme_id) REFERENCES public.themes(id) ON DELETE SET NULL;
ALTER TABLE public.sessions ADD COLUMN IF NOT EXISTS theme_override text CHECK (theme_override IN ('builtin','custom'));
ALTER TABLE public.sessions ADD COLUMN IF NOT EXISTS theme_id uuid REFERENCES public.themes(id) ON DELETE SET NULL;
ALTER TABLE public.sessions ADD COLUMN IF NOT EXISTS theme_variant text CHECK (theme_variant IN ('dark','light'));

ALTER TABLE public.commands ADD COLUMN IF NOT EXISTS work_id uuid REFERENCES public.works(id) ON DELETE CASCADE;
ALTER TABLE public.commands ADD CONSTRAINT work_command_not_published CHECK (work_id IS NULL OR NOT is_published);
CREATE INDEX commands_work_idx ON public.commands(work_id) WHERE work_id IS NOT NULL;
DROP POLICY IF EXISTS commands_select_own_or_published ON public.commands;
DROP POLICY IF EXISTS commands_insert_own ON public.commands;
DROP POLICY IF EXISTS commands_update_own ON public.commands;
DROP POLICY IF EXISTS commands_delete_own ON public.commands;
CREATE POLICY commands_read_scope ON public.commands FOR SELECT TO authenticated
  USING ((work_id IS NULL AND (owner_id=auth.uid() OR is_published))
    OR (work_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.works w WHERE w.id=commands.work_id)));
CREATE POLICY commands_insert_scope ON public.commands FOR INSERT TO authenticated
  WITH CHECK (owner_id=auth.uid() AND NOT is_published
    AND (work_id IS NULL OR public.can_edit_work(work_id)));
CREATE POLICY commands_update_scope ON public.commands FOR UPDATE TO authenticated
  USING ((work_id IS NULL AND owner_id=auth.uid()) OR (work_id IS NOT NULL AND public.can_edit_work(work_id)))
  WITH CHECK ((work_id IS NULL AND owner_id=auth.uid()) OR (work_id IS NOT NULL AND public.can_edit_work(work_id)));
CREATE POLICY commands_delete_scope ON public.commands FOR DELETE TO authenticated
  USING ((work_id IS NULL AND owner_id=auth.uid()) OR (work_id IS NOT NULL AND public.can_edit_work(work_id)));

-- Validate theme references even when clients bypass their selection UI.
CREATE OR REPLACE FUNCTION public.validate_theme_reference() RETURNS trigger
LANGUAGE plpgsql SET search_path=public AS $$
DECLARE linked public.themes%ROWTYPE;
BEGIN
  IF TG_TABLE_NAME='works' THEN
    IF NEW.default_theme_id IS NULL THEN RETURN NEW; END IF;
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
    IF NEW.theme_id IS NULL THEN RAISE EXCEPTION 'Custom theme requires theme_id'; END IF;
    SELECT * INTO linked FROM public.themes WHERE id=NEW.theme_id;
    IF NOT FOUND OR (linked.work_id IS DISTINCT FROM NEW.work_id AND
      (linked.work_id IS NOT NULL OR NOT (linked.is_published OR linked.owner_id=auth.uid()))) THEN
      RAISE EXCEPTION 'Theme is not available to this session';
    END IF;
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER works_theme_guard BEFORE INSERT OR UPDATE OF default_theme_id ON public.works
  FOR EACH ROW EXECUTE FUNCTION public.validate_theme_reference();
CREATE TRIGGER sessions_theme_guard BEFORE INSERT OR UPDATE OF theme_override,theme_id,theme_variant ON public.sessions
  FOR EACH ROW EXECUTE FUNCTION public.validate_theme_reference();

COMMENT ON COLUMN public.sessions.theme_override IS 'NULL = inherit work/user preference; builtin = builtin dark/light; custom = theme_id';
COMMENT ON COLUMN public.profiles.preferred_theme_mode IS 'NULL = legacy local fallback, dark/light = builtin, custom = preferred_theme_id';
