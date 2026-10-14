-- Apply after 0040. Existing work themes remain shared; new personal work themes are private.
BEGIN;
ALTER TABLE public.platform_config ADD COLUMN IF NOT EXISTS theme_prompt text NOT NULL DEFAULT
'장면의 장소, 시간, 분위기와 테마별 적용 조건을 판단하세요.
응답 맨 아래에 {{theme::테마이름}}을 한 개 출력하세요. 변경할 필요가 없으면 {{theme::keep}}을 출력하세요.
사용 가능한 목록의 이름만 정확히 사용하고, 본문에서 테마 변경을 설명하지 마세요.';
ALTER TABLE public.sessions ADD COLUMN IF NOT EXISTS auto_theme_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE public.themes ADD COLUMN IF NOT EXISTS ai_prompt text NOT NULL DEFAULT '' CHECK (char_length(ai_prompt)<=4000);
ALTER TABLE public.themes ADD COLUMN IF NOT EXISTS work_shared boolean NOT NULL DEFAULT true;

-- No new write policy for config: preserve the existing administrator-only policy.
DROP POLICY IF EXISTS themes_read ON public.themes;
CREATE POLICY themes_read ON public.themes FOR SELECT TO public
USING (owner_id=auth.uid() OR (work_id IS NULL AND is_published)
  OR (work_id IS NOT NULL AND work_shared AND EXISTS (SELECT 1 FROM public.works w WHERE w.id=themes.work_id)));
DROP POLICY IF EXISTS themes_insert ON public.themes;
CREATE POLICY themes_insert ON public.themes FOR INSERT TO authenticated
WITH CHECK (owner_id=auth.uid() AND NOT is_published AND
  (work_id IS NULL OR (work_shared AND public.can_edit_work(work_id))
    OR (NOT work_shared AND EXISTS (SELECT 1 FROM public.works w WHERE w.id=themes.work_id))));
DROP POLICY IF EXISTS themes_update ON public.themes;
CREATE POLICY themes_update ON public.themes FOR UPDATE TO authenticated
USING ((work_id IS NULL AND owner_id=auth.uid()) OR
  (work_id IS NOT NULL AND ((work_shared AND public.can_edit_work(work_id)) OR (NOT work_shared AND owner_id=auth.uid()))))
WITH CHECK ((work_id IS NULL AND owner_id=auth.uid()) OR
  (work_id IS NOT NULL AND ((work_shared AND public.can_edit_work(work_id)) OR (NOT work_shared AND owner_id=auth.uid()))));
DROP POLICY IF EXISTS themes_delete ON public.themes;
CREATE POLICY themes_delete ON public.themes FOR DELETE TO authenticated
USING ((work_id IS NULL AND owner_id=auth.uid()) OR
  (work_id IS NOT NULL AND ((work_shared AND public.can_edit_work(work_id)) OR (NOT work_shared AND owner_id=auth.uid()))));

CREATE OR REPLACE FUNCTION public.keep_theme_visibility() RETURNS trigger
LANGUAGE plpgsql SET search_path=public AS $$
BEGIN
  IF NEW.work_shared IS DISTINCT FROM OLD.work_shared THEN
    RAISE EXCEPTION 'Theme sharing scope cannot be changed';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER themes_keep_visibility BEFORE UPDATE ON public.themes
FOR EACH ROW EXECUTE FUNCTION public.keep_theme_visibility();

CREATE OR REPLACE FUNCTION public.validate_theme_reference() RETURNS trigger
LANGUAGE plpgsql SET search_path=public AS $$
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
    IF NEW.theme_override IS NULL THEN NEW.theme_id:=NULL; NEW.theme_variant:=NULL; RETURN NEW; END IF;
    IF NEW.theme_override='builtin' THEN NEW.theme_id:=NULL; RETURN NEW; END IF;
    IF NEW.theme_id IS NULL THEN
      IF TG_OP='UPDATE' AND OLD.theme_id IS NOT NULL THEN NEW.theme_override:=NULL; NEW.theme_variant:=NULL; RETURN NEW; END IF;
      RAISE EXCEPTION 'Custom theme requires theme_id';
    END IF;
    SELECT * INTO linked FROM public.themes WHERE id=NEW.theme_id;
    IF NOT FOUND OR (linked.work_id IS NOT NULL AND (linked.work_id<>NEW.work_id
      OR (NOT linked.work_shared AND linked.owner_id<>NEW.user_id)))
      OR (linked.work_id IS NULL AND NOT (linked.is_published OR linked.owner_id=NEW.user_id)) THEN
      RAISE EXCEPTION 'Theme is not available to this session';
    END IF;
  END IF;
  RETURN NEW;
END; $$;
-- Recheck when a session is moved to another work or owner, too.
DROP TRIGGER IF EXISTS sessions_theme_guard ON public.sessions;
CREATE TRIGGER sessions_theme_guard BEFORE INSERT OR UPDATE OF theme_override,theme_id,theme_variant,work_id,user_id ON public.sessions
FOR EACH ROW EXECUTE FUNCTION public.validate_theme_reference();
COMMIT;
