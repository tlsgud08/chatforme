-- Add presentation preferences only; existing chat content, palettes and RLS stay intact.
ALTER TABLE public.themes
  ADD COLUMN IF NOT EXISTS code_block_style text NOT NULL DEFAULT 'basic'
  CONSTRAINT themes_code_block_style_check CHECK (code_block_style IN
    ('basic','legacy','neon','corporate','hanji','scroll','grimoire','noir','notebook'));

ALTER TABLE public.sessions
  ADD COLUMN IF NOT EXISTS use_theme_code_block boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS code_block_style text
  CONSTRAINT sessions_code_block_style_check CHECK (code_block_style IN
    ('basic','legacy','neon','corporate','hanji','scroll','grimoire','noir','notebook'));

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS use_legacy_status boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.themes.code_block_style IS 'Status/code-block appearance; colors follow this theme except fixed-color Legacy';
COMMENT ON COLUMN public.sessions.use_theme_code_block IS 'Use the visible theme appearance; false preserves the room code_block_style';
COMMENT ON COLUMN public.sessions.code_block_style IS 'Last fixed room choice, retained when theme inheritance is re-enabled';
COMMENT ON COLUMN public.profiles.use_legacy_status IS 'Force the unchanged original status-window appearance and colors for this account';

NOTIFY pgrst, 'reload schema';
