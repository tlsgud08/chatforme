-- New accounts default to the complete source dialogue. Existing account and
-- room choices stay intact; room creation already snapshots the account choice.
alter table public.profiles alter column summary_source_mode set default 'full';
