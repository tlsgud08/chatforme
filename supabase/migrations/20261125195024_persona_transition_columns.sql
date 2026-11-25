set local lock_timeout = '3s';
alter table public.profiles add column if not exists persona_transition_notice_enabled boolean not null default true;
alter table public.platform_config add column if not exists persona_transition_notice_template text not null default '';
alter table public.messages add column if not exists author_persona_name text;
