-- Allow the configured Inuchat administrator to inspect and remove any work.
-- Keep this email in sync with VITE_ADMIN_EMAIL.
drop policy if exists "works_select_by_visibility" on public.works;
create policy "works_select_by_visibility" on public.works for select using (
  visibility in ('public', 'unlisted')
  or auth.uid() = creator_id
  or auth.email() = 'topshjtv@gmail.com'
);

drop policy if exists "works_delete_admin" on public.works;
create policy "works_delete_admin" on public.works for delete using (
  auth.email() = 'topshjtv@gmail.com'
);
