-- Allow plugin prompt bodies of any length while keeping them non-empty.
-- The following migration removes name/description caps. Command limits are unchanged.
ALTER TABLE public.plugins
  DROP CONSTRAINT IF EXISTS plugins_prompt_check,
  DROP CONSTRAINT IF EXISTS plugins_prompt_nonempty_check;

ALTER TABLE public.plugins
  ADD CONSTRAINT plugins_prompt_nonempty_check
  CHECK (char_length(prompt) >= 1);
