create table if not exists public.work_editors (
  work_id uuid not null references public.works(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  granted_by uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (work_id, user_id)
);
create index if not exists work_editors_user_idx on public.work_editors(user_id);
alter table public.work_editors enable row level security;

create or replace function public.is_app_admin()
returns boolean language sql stable security definer set search_path = public
as $$ select coalesce(auth.email() = 'topshjtv@gmail.com', false) $$;

create or replace function public.can_edit_work(target_work_id uuid)
returns boolean language sql stable security definer set search_path = public
as $$
  select public.is_app_admin()
    or exists (select 1 from public.works w where w.id = target_work_id and w.creator_id = auth.uid())
    or exists (select 1 from public.work_editors e where e.work_id = target_work_id and e.user_id = auth.uid())
$$;
revoke all on function public.is_app_admin() from public;
revoke all on function public.can_edit_work(uuid) from public;
grant execute on function public.is_app_admin(), public.can_edit_work(uuid) to authenticated;

create policy "work_editors_select" on public.work_editors for select using (user_id = auth.uid() or public.can_edit_work(work_id));
create policy "work_editors_insert" on public.work_editors for insert with check (
  granted_by = auth.uid()
  and exists (select 1 from public.works w where w.id = work_id and w.creator_id = auth.uid())
  and user_id <> auth.uid()
);
create policy "work_editors_delete" on public.work_editors for delete using (
  exists (select 1 from public.works w where w.id = work_id and w.creator_id = auth.uid())
);

drop policy if exists "works_select_by_visibility" on public.works;
create policy "works_select_by_visibility" on public.works for select using (visibility in ('public', 'unlisted') or public.can_edit_work(id));
drop policy if exists "works_update_own" on public.works;
create policy "works_update_editors" on public.works for update using (public.can_edit_work(id)) with check (public.can_edit_work(id));

create or replace function public.keep_work_creator_immutable()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.creator_id is distinct from old.creator_id then
    raise exception 'work creator cannot be changed';
  end if;
  return new;
end;
$$;
drop trigger if exists keep_work_creator_immutable on public.works;
create trigger keep_work_creator_immutable before update on public.works
for each row execute function public.keep_work_creator_immutable();

drop policy if exists "kb_write" on public.keyword_books;
drop policy if exists "kb_select" on public.keyword_books;
create policy "kb_select" on public.keyword_books for select using (
  exists (select 1 from public.works w where w.id = work_id and w.visibility in ('public', 'unlisted')) or public.can_edit_work(work_id)
);
create policy "kb_write" on public.keyword_books for all using (public.can_edit_work(work_id)) with check (public.can_edit_work(work_id));
drop policy if exists "start_configs_select" on public.start_configs;
create policy "start_configs_select" on public.start_configs for select using (
  exists (select 1 from public.works w where w.id = work_id and w.visibility in ('public', 'unlisted')) or public.can_edit_work(work_id)
);
drop policy if exists "start_configs_write" on public.start_configs;
create policy "start_configs_write" on public.start_configs for all using (public.can_edit_work(work_id)) with check (public.can_edit_work(work_id));

create or replace function public.search_work_editor_candidates(target_work_id uuid, search_text text)
returns table (id uuid, display_name text, avatar_url text)
language sql stable security definer set search_path = public
as $$
  select p.id, p.display_name, p.avatar_url from public.profiles p
  where exists (select 1 from public.works w where w.id = target_work_id and w.creator_id = auth.uid())
    and p.id <> auth.uid() and length(trim(search_text)) >= 1
    and p.display_name ilike '%' || trim(search_text) || '%'
  order by p.display_name limit 20
$$;
revoke all on function public.search_work_editor_candidates(uuid, text) from public;
grant execute on function public.search_work_editor_candidates(uuid, text) to authenticated;

create or replace function public.get_work_editors(target_work_id uuid)
returns table (user_id uuid, display_name text, avatar_url text, created_at timestamptz)
language sql stable security definer set search_path = public
as $$
  select e.user_id, p.display_name, p.avatar_url, e.created_at
  from public.work_editors e join public.profiles p on p.id = e.user_id
  where e.work_id = target_work_id
    and exists (select 1 from public.works w where w.id = target_work_id and w.creator_id = auth.uid())
  order by e.created_at
$$;
revoke all on function public.get_work_editors(uuid) from public;
grant execute on function public.get_work_editors(uuid) to authenticated;
