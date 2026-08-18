-- A turn is a single summary checkpoint. Keep the newest historical row if
-- older deployments already produced duplicates, then enforce the invariant.
delete from public.summary_versions older
using public.summary_versions newer
where older.session_id = newer.session_id
  and older.summarized_through_turn = newer.summarized_through_turn
  and (older.created_at, older.id) < (newer.created_at, newer.id);

create unique index if not exists summary_versions_one_per_turn_idx
  on public.summary_versions(session_id, summarized_through_turn);
