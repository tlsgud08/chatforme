alter table public.semi_session_links add column sync_date_a text,add column sync_date_b text;

create function private.refresh_semi_sync_date(target_session uuid) returns void
language plpgsql security definer set search_path=public,pg_temp as $$
declare value text;
begin
 if not exists(select 1 from public.semi_session_links where status='active' and target_session in(session_a,session_b)) then return; end if;
 select btrim(tag.parts[1]) into value from public.messages m
 cross join lateral regexp_matches(m.content,E'\\{\\{sync_date::([^{}\\r\\n]{1,200})\\}\\}','g') with ordinality as tag(parts,position)
 where m.session_id=target_session and m.role='assistant' and m.is_active_variant and not m.is_hidden and m.generation_status='complete'
  and nullif(btrim(tag.parts[1]),'') is not null
 order by m.turn_index desc,m.created_at desc,m.id desc,tag.position desc limit 1;
 update public.semi_session_links set sync_date_a=case when session_a=target_session then value else sync_date_a end,
  sync_date_b=case when session_b=target_session then value else sync_date_b end
 where status='active' and ((session_a=target_session and sync_date_a is distinct from value) or (session_b=target_session and sync_date_b is distinct from value));
end $$;
revoke all on function private.refresh_semi_sync_date(uuid) from public,anon,authenticated;

create function private.semi_sync_date_message_changed() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if tg_op='DELETE' then
  if old.role='assistant' and old.generation_status='complete' then perform private.refresh_semi_sync_date(old.session_id); end if;
 else
  if new.role='assistant' and (new.generation_status='complete' or (tg_op='UPDATE' and old.generation_status='complete')) then perform private.refresh_semi_sync_date(new.session_id); end if;
 end if;
 return null;
end $$;
revoke all on function private.semi_sync_date_message_changed() from public,anon,authenticated;
create trigger semi_sync_date_message_changed after insert or delete or update of content,generation_status,is_active_variant,is_hidden,turn_index on public.messages
 for each row execute function private.semi_sync_date_message_changed();

create function private.semi_sync_date_link_changed() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if new.status='active' then
  perform private.refresh_semi_sync_date(new.session_a);perform private.refresh_semi_sync_date(new.session_b);
 else
  update public.semi_session_links set sync_date_a=null,sync_date_b=null where id=new.id and (sync_date_a is not null or sync_date_b is not null);
 end if;
 return null;
end $$;
revoke all on function private.semi_sync_date_link_changed() from public,anon,authenticated;
create trigger semi_sync_date_link_changed after insert or update of status on public.semi_session_links for each row execute function private.semi_sync_date_link_changed();
do $$ declare sid uuid;begin
 for sid in select session_a from public.semi_session_links where status='active' union select session_b from public.semi_session_links where status='active' loop perform private.refresh_semi_sync_date(sid); end loop;
end $$;
notify pgrst,'reload schema';
