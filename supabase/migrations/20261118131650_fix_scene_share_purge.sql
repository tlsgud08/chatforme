create or replace function scene_sharing.purge_all()
returns integer language plpgsql security definer set search_path = '' as $$
declare removed integer;
begin
  if auth.uid() is null or not coalesce(public.is_app_admin(), false) then
    raise exception 'SCENE_ADMIN_REQUIRED' using errcode = '42501';
  end if;

  -- Serialize the cleanup with share creation and revocation.
  lock table scene_sharing.shares in share row exclusive mode;
  -- The Data API requires an explicit predicate for DELETE (pg-safeupdate).
  delete from scene_sharing.shares where token is not null;
  get diagnostics removed = row_count;
  return removed;
end;
$$;

