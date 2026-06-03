-- Allow admin user to update platform_config
create policy "config_update_admin" on public.platform_config
  for update
  using (auth.email() = 'topshjtv@gmail.com');
