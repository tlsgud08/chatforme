-- User-authored story notes are supplemental memory and never trim chat history.
create table if not exists public.story_notes (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions(id) on delete cascade,
  content text not null check (char_length(content) <= 10000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists story_notes_session_idx on public.story_notes(session_id, created_at);
alter table public.story_notes enable row level security;
create policy "story_notes_select" on public.story_notes for select using (
  exists (select 1 from public.sessions s where s.id = session_id and s.user_id = auth.uid())
);
create policy "story_notes_insert" on public.story_notes for insert with check (
  exists (select 1 from public.sessions s where s.id = session_id and s.user_id = auth.uid())
);
create policy "story_notes_update" on public.story_notes for update using (
  exists (select 1 from public.sessions s where s.id = session_id and s.user_id = auth.uid())
);
create policy "story_notes_delete" on public.story_notes for delete using (
  exists (select 1 from public.sessions s where s.id = session_id and s.user_id = auth.uid())
);
