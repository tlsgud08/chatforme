-- A browser retry, remount, or second tab must not create another row for the
-- same logical turn. Keep the best copy of historical duplicates before adding
-- constraints so this migration can be applied to databases already affected.
with ranked_user_messages as (
  select id,
    row_number() over (
      partition by session_id, turn_index
      order by created_at asc, id asc
    ) as duplicate_rank
  from public.messages
  where role = 'user' and is_hidden = false
)
delete from public.messages
where id in (
  select id from ranked_user_messages where duplicate_rank > 1
);

with ranked_assistant_messages as (
  select id,
    row_number() over (
      partition by session_id, turn_index, reroll_index
      order by
        case generation_status when 'complete' then 0 when 'interrupted' then 1 else 2 end,
        output_tokens desc,
        length(content) desc,
        created_at desc,
        id desc
    ) as duplicate_rank
  from public.messages
  where role = 'assistant' and is_hidden = false
)
delete from public.messages
where id in (
  select id from ranked_assistant_messages where duplicate_rank > 1
);

create unique index if not exists messages_one_user_per_turn_idx
  on public.messages(session_id, turn_index)
  where role = 'user' and is_hidden = false;

create unique index if not exists messages_one_assistant_variant_per_turn_idx
  on public.messages(session_id, turn_index, reroll_index)
  where role = 'assistant' and is_hidden = false;
