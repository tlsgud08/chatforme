-- Supabase installs pgcrypto functions in the `extensions` schema. Rooms
-- created before this fix failed while resolving gen_salt()/crypt().
alter function public.create_multichat(uuid, text, text, text, integer)
  set search_path = public, extensions;

alter function public.join_multichat(text, text)
  set search_path = public, extensions;

alter function public.set_multichat_password(uuid, text)
  set search_path = public, extensions;
