alter table public.platform_config
  add column if not exists work_prompt_label  text not null default '작품 설정',
  add column if not exists persona_label      text not null default '{{user}} info',
  add column if not exists user_note_label    text not null default 'Additional info & rules',
  add column if not exists summary_label      text not null default 'Plot summary';
