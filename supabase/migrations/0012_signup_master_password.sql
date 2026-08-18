-- Private signup gate for this personal Inuchat instance.
create extension if not exists pgcrypto;
create schema if not exists private;

create table if not exists private.signup_config (
  id boolean primary key default true check (id),
  password_hash text not null,
  updated_at timestamptz not null default now()
);

create or replace function public.verify_signup_master_password(candidate text)
returns boolean
language sql
security definer
set search_path = private, public, extensions
as $$
  select coalesce(
    (select password_hash = crypt(candidate, password_hash)
       from private.signup_config
      where id = true),
    false
  );
$$;

create or replace function public.set_signup_master_password(new_password text)
returns void
language plpgsql
security definer
set search_path = private, public, extensions
as $$
begin
  if auth.email() is distinct from 'topshjtv@gmail.com' then
    raise exception 'administrator only';
  end if;
  if length(new_password) < 8 then
    raise exception 'master password must be at least 8 characters';
  end if;

  insert into private.signup_config (id, password_hash, updated_at)
  values (true, crypt(new_password, gen_salt('bf')), now())
  on conflict (id) do update
    set password_hash = excluded.password_hash,
        updated_at = excluded.updated_at;
end;
$$;

revoke all on function public.verify_signup_master_password(text) from public;
grant execute on function public.verify_signup_master_password(text) to anon, authenticated;
revoke all on function public.set_signup_master_password(text) from public;
grant execute on function public.set_signup_master_password(text) to authenticated;
