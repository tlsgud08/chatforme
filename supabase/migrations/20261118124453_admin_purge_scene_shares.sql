create function scene_sharing.purge_all()
returns integer language plpgsql security definer set search_path = '' as $$
declare removed integer;
begin
  if auth.uid() is null or not coalesce(public.is_app_admin(), false) then
    raise exception 'SCENE_ADMIN_REQUIRED' using errcode = '42501';
  end if;

  -- Serialize the cleanup with share creation and revocation.
  lock table scene_sharing.shares in share row exclusive mode;
  delete from scene_sharing.shares;
  get diagnostics removed = row_count;
  return removed;
end;
$$;

create function public.purge_scene_shares()
returns integer language sql security invoker set search_path = '' as $$
  select scene_sharing.purge_all();
$$;

revoke execute on function scene_sharing.purge_all(), public.purge_scene_shares() from public, anon, authenticated;
grant execute on function scene_sharing.purge_all(), public.purge_scene_shares() to authenticated;
