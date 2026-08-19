-- 실행 당시의 명령어를 유저 메시지에 기록한다. 명령어 본문은 저장하지 않아
-- 대화 기록에서 재호출되지 않으며, 해당 턴을 보낸 순간에만 사용된다.
alter table public.messages
  add column if not exists command_id uuid references public.commands(id) on delete set null,
  add column if not exists command_name text check (command_name is null or char_length(command_name) between 1 and 20);

create index if not exists messages_command_idx
  on public.messages (command_id) where command_id is not null;

-- profiles 행 전체를 공개하지 않고 허브 게시자 이름만 안전하게 조회한다.
create or replace function public.command_author_names(author_ids uuid[])
returns table(id uuid, display_name text)
language sql
stable
security definer
set search_path = public
as $$
  select p.id, p.display_name
  from public.profiles p
  where p.id = any(author_ids)
    and (
      p.id = auth.uid()
      or exists (
        select 1 from public.commands c
        where c.owner_id = p.id and c.is_published
      )
    );
$$;

revoke all on function public.command_author_names(uuid[]) from public;
grant execute on function public.command_author_names(uuid[]) to authenticated;
