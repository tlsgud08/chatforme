-- ============================================================
-- ChatForMe 초기 스키마 (Phase 1)
-- Supabase SQL Editor 또는 supabase db push 로 실행
-- ============================================================

-- ---------- profiles : 사용자 프로필/기본 설정 ----------
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default '',
  default_output_tokens int not null default 1024,
  default_provider text not null default 'claude',  -- claude | gemini | openai
  default_model text not null default '',
  created_at timestamptz not null default now()
);

-- ---------- platform_config : 전역 시스템 프롬프트(관리자 전용) ----------
create table if not exists public.platform_config (
  id int primary key default 1,
  system_prompt text not null default '',
  updated_at timestamptz not null default now(),
  constraint single_row check (id = 1)
);
insert into public.platform_config (id, system_prompt)
  values (1, '') on conflict (id) do nothing;

-- ---------- works : 작품 ----------
create table if not exists public.works (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null references auth.users(id) on delete cascade,
  title text not null default '',
  description text not null default '',
  thumbnail_url text,
  main_prompt text not null default '',
  is_published boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists works_creator_idx on public.works(creator_id);
create index if not exists works_created_idx on public.works(created_at desc);

-- ---------- keyword_books : 키워드북 (Phase 2에서 UI 연결) ----------
create table if not exists public.keyword_books (
  id uuid primary key default gen_random_uuid(),
  work_id uuid not null references public.works(id) on delete cascade,
  name text not null default '',
  keywords text[] not null default '{}',      -- 최대 5개 (앱에서 검증)
  content text not null default '',            -- 최대 500자 (앱에서 검증)
  activation_turns int not null default 3,     -- 1~5
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists keyword_books_work_idx on public.keyword_books(work_id);

-- ---------- personas : 사용자 페르소나 (Phase 2에서 UI 연결) ----------
create table if not exists public.personas (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null default '',               -- 최대 20자
  description text not null default '',         -- 최대 300자
  created_at timestamptz not null default now()
);
create index if not exists personas_user_idx on public.personas(user_id);

-- ---------- sessions : 채팅방/세션 ----------
create table if not exists public.sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  work_id uuid not null references public.works(id) on delete cascade,
  title text not null default '',
  persona_id uuid references public.personas(id) on delete set null,
  user_note text not null default '',          -- 세션별 유저 노트, 최대 2000자 (앱에서 검증)
  output_tokens_override int,                  -- null이면 프로필 기본값 사용
  summary text not null default '',            -- 요약 메모리 (Phase 3에서 채움)
  total_input_tokens bigint not null default 0,
  total_output_tokens bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists sessions_user_idx on public.sessions(user_id, updated_at desc);

-- ---------- messages : 메시지 ----------
create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions(id) on delete cascade,
  role text not null,                          -- user | assistant
  content text not null default '',
  turn_index int not null default 0,
  input_tokens int not null default 0,
  output_tokens int not null default 0,
  is_summarized boolean not null default false,-- 요약 메모리에 포함되었는지 (추후 사용)
  created_at timestamptz not null default now()
);
create index if not exists messages_session_idx on public.messages(session_id, created_at);

-- ============================================================
-- 자동 프로필 생성 트리거 (회원가입 시)
-- ============================================================
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data->>'name', split_part(new.email, '@', 1)))
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ============================================================
-- RLS (Row Level Security)
-- ============================================================
alter table public.profiles       enable row level security;
alter table public.platform_config enable row level security;
alter table public.works          enable row level security;
alter table public.keyword_books  enable row level security;
alter table public.personas       enable row level security;
alter table public.sessions       enable row level security;
alter table public.messages       enable row level security;

-- profiles: 본인 것만
create policy "profiles_select_own" on public.profiles for select using (auth.uid() = id);
create policy "profiles_upsert_own" on public.profiles for insert with check (auth.uid() = id);
create policy "profiles_update_own" on public.profiles for update using (auth.uid() = id);

-- platform_config: 모두 읽기, 쓰기는 service_role(관리자 화면은 추후) 만
create policy "config_select_all" on public.platform_config for select using (true);

-- works: 게시된 작품은 모두 읽기 / 작성자만 쓰기·수정·삭제
create policy "works_select_published" on public.works for select using (is_published or auth.uid() = creator_id);
create policy "works_insert_own" on public.works for insert with check (auth.uid() = creator_id);
create policy "works_update_own" on public.works for update using (auth.uid() = creator_id);
create policy "works_delete_own" on public.works for delete using (auth.uid() = creator_id);

-- keyword_books: 소속 작품의 작성자만 / 읽기는 게시 작품이면 모두
create policy "kb_select" on public.keyword_books for select using (
  exists (select 1 from public.works w where w.id = work_id and (w.is_published or w.creator_id = auth.uid()))
);
create policy "kb_write" on public.keyword_books for all using (
  exists (select 1 from public.works w where w.id = work_id and w.creator_id = auth.uid())
) with check (
  exists (select 1 from public.works w where w.id = work_id and w.creator_id = auth.uid())
);

-- personas: 본인 것만
create policy "personas_all_own" on public.personas for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- sessions: 본인 것만
create policy "sessions_all_own" on public.sessions for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- messages: 소속 세션 소유자만
create policy "messages_select_own" on public.messages for select using (
  exists (select 1 from public.sessions s where s.id = session_id and s.user_id = auth.uid())
);
create policy "messages_write_own" on public.messages for all using (
  exists (select 1 from public.sessions s where s.id = session_id and s.user_id = auth.uid())
) with check (
  exists (select 1 from public.sessions s where s.id = session_id and s.user_id = auth.uid())
);

-- ============================================================
-- Storage: 썸네일 버킷 (대시보드에서 'thumbnails' public 버킷 생성 권장)
-- 또는 아래로 생성:
-- insert into storage.buckets (id, name, public) values ('thumbnails','thumbnails', true);
-- ============================================================
