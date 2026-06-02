-- 채팅방 보관 기능
alter table public.sessions
  add column if not exists is_archived boolean not null default false;

create index if not exists sessions_archived_idx on public.sessions(user_id, is_archived);
