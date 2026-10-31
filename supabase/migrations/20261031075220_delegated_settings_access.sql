-- Delegation is limited to platform settings; work/chat administrator rights stay unchanged.
create table public.settings_admins (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  granted_by uuid references public.profiles(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now()
);
alter table public.settings_admins enable row level security;
revoke all on public.settings_admins from anon,authenticated;
grant select,insert,delete on public.settings_admins to authenticated;
create policy settings_admins_read on public.settings_admins for select to authenticated
  using (user_id=(select auth.uid()) or public.is_app_admin());
create policy settings_admins_grant on public.settings_admins for insert to authenticated
  with check (public.is_app_admin() and granted_by=(select auth.uid()));
create policy settings_admins_revoke on public.settings_admins for delete to authenticated
  using (public.is_app_admin());

create function public.is_settings_admin() returns boolean
language sql stable security invoker set search_path=public,pg_temp as $$
  select (select auth.uid()) is not null and (public.is_app_admin()
    or exists(select 1 from public.settings_admins where user_id=(select auth.uid())))
$$;
revoke all on function public.is_settings_admin() from public,anon;
grant execute on function public.is_settings_admin() to authenticated;
create policy config_update_settings_admin on public.platform_config for update to authenticated
  using (public.is_settings_admin()) with check (public.is_settings_admin());

-- Retain transaction/CAS/password validation and existing privileges; change only the settings guard.
do $$ declare signature text; definition text; updated text; begin
  foreach signature in array array['public.save_admin_settings(jsonb,jsonb,text)',
    'public.save_global_summary_prompt(text,text)','public.save_semi_multichat_prompt(text,text)',
    'public.save_semi_sync_summary_prompt(text,text)'] loop
    select pg_get_functiondef(signature::regprocedure) into definition;
    updated:=replace(definition,'public.is_app_admin()','public.is_settings_admin()');
    if updated=definition then raise exception 'Unexpected settings guard: %',signature; end if;
    execute updated;
  end loop;
  -- Some local test fixtures omit the pgcrypto-backed signup gate.
  if to_regprocedure('public.set_signup_master_password(text)') is not null then
    select pg_get_functiondef('public.set_signup_master_password(text)'::regprocedure) into definition;
    updated:=replace(definition,'auth.email() is distinct from ''topshjtv@gmail.com''',
      'auth.uid() is null or not public.is_settings_admin()');
    if updated=definition then raise exception 'Unexpected signup settings guard'; end if;
    execute updated;
  end if;
end $$;
notify pgrst,'reload schema';
