alter table public.session_folders add column parent_id uuid;
alter table public.session_folders add constraint session_folders_id_owner_unique unique(id,user_id);
alter table public.session_folders add constraint session_folders_parent_owner_fk foreign key(parent_id,user_id) references public.session_folders(id,user_id) on delete cascade;
create index session_folders_parent_idx on public.session_folders(parent_id,user_id);
-- Parents are assigned only when a folder is created, preventing cycles and reparenting.
create function public.keep_session_folder_parent() returns trigger language plpgsql set search_path=public as $$
begin
  if TG_OP = 'UPDATE' and (new.parent_id is distinct from old.parent_id or new.id is distinct from old.id or new.user_id is distinct from old.user_id) then
    raise exception '폴더의 상위 경로는 변경할 수 없습니다.';
  end if;
  if new.parent_id is not null and (new.parent_id = new.id or not exists (select 1 from public.session_folders f where f.id = new.parent_id and f.user_id = new.user_id)) then
    raise exception '상위 폴더를 찾을 수 없습니다.';
  end if;
  return new;
end;
$$;
revoke all on function public.keep_session_folder_parent() from public,anon,authenticated;
create trigger session_folder_parent_immutable before insert or update on public.session_folders for each row execute function public.keep_session_folder_parent();
