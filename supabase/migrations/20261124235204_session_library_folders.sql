-- System folders are derived from sessions; only user-created folders are stored.
-- Keep is_archived as the bookmark flag so existing archives retain their marks.
create table public.session_folders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 60),
  created_at timestamptz not null default now()
);
create index session_folders_user_idx on public.session_folders(user_id);
create table public.session_folder_items (
  folder_id uuid not null references public.session_folders(id) on delete cascade,
  session_id uuid not null references public.sessions(id) on delete cascade,
  primary key (folder_id, session_id)
);
create index session_folder_items_session_idx on public.session_folder_items(session_id);
alter table public.session_folders enable row level security;
alter table public.session_folder_items enable row level security;
create policy session_folders_owner on public.session_folders for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
create policy session_folder_items_owner on public.session_folder_items for all to authenticated
  using (exists (select 1 from public.session_folders f where f.id = folder_id and f.user_id = (select auth.uid())))
  with check (
    exists (select 1 from public.session_folders f where f.id = folder_id and f.user_id = (select auth.uid()))
    and exists (select 1 from public.sessions s where s.id = session_id and s.user_id = (select auth.uid()) and s.multichat_room_id is null)
  );
grant select, insert, update, delete on public.session_folders, public.session_folder_items to authenticated;

-- Save the folder and its selected rooms in one transaction. RLS applies throughout.
create function public.save_session_folder(target_folder uuid, folder_name text, session_ids uuid[])
returns void language plpgsql security invoker set search_path = public as $$
declare
  owner_id uuid := auth.uid();
begin
  if owner_id is null then raise exception '로그인이 필요합니다.'; end if;
  if target_folder is null or folder_name is null or char_length(btrim(folder_name)) not between 1 and 60 then
    raise exception '폴더 이름은 1~60자로 입력해 주세요.';
  end if;
  if exists (
    select 1 from unnest(coalesce(session_ids, array[]::uuid[])) chosen(id)
    where not exists (select 1 from public.sessions s where s.id = chosen.id and s.user_id = owner_id and s.multichat_room_id is null)
  ) then raise exception '선택한 채팅방을 찾을 수 없습니다.'; end if;
  insert into public.session_folders(id, user_id, name) values(target_folder, owner_id, btrim(folder_name))
    on conflict(id) do update set name = excluded.name;
  -- The upsert locks the folder before replacing membership, serializing edits.
  delete from public.session_folder_items where folder_id = target_folder;
  insert into public.session_folder_items(folder_id, session_id)
    select target_folder, chosen.id from (select distinct unnest(coalesce(session_ids, array[]::uuid[])) id) chosen;
end;
$$;
revoke all on function public.save_session_folder(uuid, text, uuid[]) from public, anon;
grant execute on function public.save_session_folder(uuid, text, uuid[]) to authenticated;
