alter table public.messages
  add column if not exists generation_status text not null default 'complete'
  check (generation_status in ('streaming', 'complete', 'interrupted'));

create index if not exists messages_streaming_idx
  on public.messages(session_id, generation_status)
  where generation_status = 'streaming';
