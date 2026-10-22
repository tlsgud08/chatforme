-- Ordered references only: prompts are re-read through works RLS for each request.
-- Applying this migration never enables combination in an existing session.
alter table public.sessions
  add column if not exists work_combination_enabled boolean not null default false,
  add column if not exists combined_work_ids uuid[] not null default '{}';

alter table public.platform_config
  add column if not exists work_combination_prompt text not null default '아래 작품들은 하나의 대화에 함께 적용된다. 설정이나 지시가 충돌하면 메인 작품을 최우선으로 따르고, 추가 작품은 지정된 우선순위에 따른다. 충돌하지 않는 설정은 함께 적용한다. 우선순위가 낮다는 이유만으로 해당 작품의 인물이나 설정을 생략하지 않는다.';

-- SECURITY INVOKER is intentional: the normal user's works RLS must apply.
create or replace function public.validate_session_work_combination()
returns trigger language plpgsql security invoker set search_path = public as $$
begin
  if coalesce(array_ndims(new.combined_work_ids), 1) <> 1
     or coalesce(array_lower(new.combined_work_ids, 1), 1) <> 1
     or array_position(new.combined_work_ids, null) is not null
     or new.work_id = any(new.combined_work_ids)
     or cardinality(new.combined_work_ids) <> (select count(distinct id) from unnest(new.combined_work_ids) as id) then
    raise exception 'Invalid work combination: use distinct additional work IDs, excluding the main work' using errcode = '23514';
  end if;
  -- Disabling/removing stale entries must remain possible after access is revoked.
  if new.work_combination_enabled and cardinality(new.combined_work_ids) > 0 then
    if (select count(*) from public.works where id = any(new.combined_work_ids)) <> cardinality(new.combined_work_ids) then
      raise exception 'A combined work is missing or inaccessible' using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function public.validate_session_work_combination() from public;

drop trigger if exists validate_session_work_combination on public.sessions;
create trigger validate_session_work_combination
  before insert or update of work_combination_enabled, combined_work_ids, work_id
  on public.sessions for each row execute function public.validate_session_work_combination();

-- Existing sessions and platform_config RLS policies cover these added columns.
-- No new table grants or RLS exceptions are needed.
