-- Remove explicit character limits from plugin names and descriptions.
-- The prompt body was already made unlimited by the preceding migration.
-- Keep required names nonempty; all existing plugin rows remain unchanged.
ALTER TABLE public.plugins
  DROP CONSTRAINT IF EXISTS plugins_name_check,
  DROP CONSTRAINT IF EXISTS plugins_description_check,
  DROP CONSTRAINT IF EXISTS plugins_name_nonempty_check;

ALTER TABLE public.plugins
  ADD CONSTRAINT plugins_name_nonempty_check
  CHECK (char_length(name) >= 1);
