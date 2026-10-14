-- Opacity is optional (client default 65%) and must be an integer from 0 to 100.
BEGIN;
CREATE OR REPLACE FUNCTION public.valid_theme_palette(p jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=public AS $$
SELECT CASE WHEN p IS NULL THEN true ELSE COALESCE(
  jsonb_typeof(p)='object'
  AND (p->>'accent') ~ '^#[0-9A-Fa-f]{6}$'
  AND (p->>'accentText') ~ '^#[0-9A-Fa-f]{6}$'
  AND (p->>'main') ~ '^#[0-9A-Fa-f]{6}$'
  AND (p->>'mainText') ~ '^#[0-9A-Fa-f]{6}$'
  AND (NOT (p ? 'secondaryText') OR (
    jsonb_typeof(p->'secondaryText')='string'
    AND (p->>'secondaryText') ~ '^#[0-9A-Fa-f]{6}$'
  ))
  AND (NOT (p ? 'softenSecondaryText') OR jsonb_typeof(p->'softenSecondaryText')='boolean')
  AND (NOT (p ? 'secondaryTextOpacity') OR CASE
    WHEN jsonb_typeof(p->'secondaryTextOpacity')='number' THEN
      (p->>'secondaryTextOpacity')::numeric BETWEEN 0 AND 100
      AND trunc((p->>'secondaryTextOpacity')::numeric)=(p->>'secondaryTextOpacity')::numeric
    ELSE false
  END)
, false) END
$$;
COMMIT;
