# Chat and editor recovery

This change addresses unconfirmed response saves, expired generation rows, unsafe global-prompt loads, partial work saves, and concurrent dialogue changes. API-key storage and multichat routes/functions are excluded.

## Response lifecycle

- `begin_session_response` creates the user turn and response placeholder in one owned-session transaction. The client supplies stable UUIDs for one bounded replay, so a lost acknowledgement does not create another turn or another model call. Source dialogue and memory are checked before the model is called. A replay returns the existing rows.
- The context-read RPC adds a compact `contextHash`. New clients send this hash instead of uploading all historical message metadata. An exact ID/version/selection fallback remains for compatibility. Model prompt assembly, history ordering, cache boundaries, and request parameters remain unchanged.
- Session locks serialize claims and source mutations. New clients cannot edit/select memory or source messages while another response is generating. The final source hash also catches direct writes by older clients. A conflicting result is retained as an inactive interrupted copy, with actual usage accounted once. It does not replace an existing selected reroll.
- Complete and interrupted output is retained before its last write. A failed save keeps the answer in the current screen and, when storage permits, an account/room-scoped local copy. The recovery panel can confirm the same database save, download the text, or explicitly discard the copy. It never automatically calls the model again. Full/blocked browser storage falls back to memory and explicitly asks the user to export before leaving.
- Interrupted output uses `interrupt_session_response`, not the completion endpoint; it does not invent token usage or mark partial output complete. Confirmed completed rows cannot be downgraded by this endpoint. Reroll promotion and its memory invalidation remain atomic.
- `recover_expired_session_responses` only marks streaming rows older than 15 minutes interrupted. This exceeds the existing 8-minute generation timeout. It preserves text, variant selection, usage, and message IDs. It runs on room entry and before full-history summary/export tools. A current generation is preserved. No batch repair of production conversations is part of the migration.

## Work and global settings

- Work main fields, existing start settings, and keyword books are saved together with ownership/RLS and snapshot conflict checks. Any failed child write or zero-row update rolls the transaction back. Replaying an already-saved snapshot is a no-op; it cannot overwrite a newer snapshot.
- Only the submitted editor snapshot becomes the clean baseline. Input and local drafts created while saving stay dirty. Uncommitted keyword-entry text is retained. Structural add/delete requests cannot overlap a work save. Editors are keyed by account/work so delayed results cannot affect another editor route.
- Failed/malformed global-setting loads do not create a ready empty form. Personal-profile read failures also produce an explicit retry state rather than dereferencing null.
- Global prompt saves compare the loaded values inside an admin/RLS-protected transaction. Long prompts are sent in the body, avoiding long URL equality filters. A stale writer preserves its input. The three existing fields are saved together without altering the separate work-combination prompt.

## Migration and compatibility

`20261025051847_chat_and_editor_recovery.sql` adds two message metadata columns and seven invoker functions, and replaces five existing invoker function bodies. It does not delete conversations, notes, works, or settings, and does not change table RLS policies. New functions have fixed `search_path` and no PUBLIC/anon execution permission. Existing function privileges are retained. Normal legacy response completion remains supported when no managed context hash exists.

The production database migration was applied on 2026-10-25 after explicit user approval, as migration `20261025140853_chat_and_editor_recovery`. All twelve function-body hashes match this source; all twelve remain invoker functions with fixed `search_path`, authenticated execution, and no anon execution. Both new columns and existing table RLS were verified. Security-advisor findings are unchanged from the pre-migration baseline. No production conversation or work records were modified for validation.

The database prerequisite is installed; the frontend changes remain subject to PR review and deployment. It is safe to reapply the SQL; tests verify that reapplication preserves message rows. Existing browsers may continue using the old bundle until all tabs/installations close, so frontend protection should not be assumed before the new bundle loads.

## Verification

- Node 22: complete `npm test` (23 top-level scripts), TypeScript, and production/PWA build.
- PGlite with real migrations/RLS: work rollback after a child failure; stale snapshot; permission loss; zero-row trigger; guarded replay; atomic user/draft rollback; duplicate claim; live generation guards; compact context hash; old-client edits; conflict-copy retention; idempotent costs; interrupted reroll promotion/replay; expired-only recovery; admin-only long-prompt CAS; migration reapplication.
- Actual locked Supabase SDK with injected network/body failures: bounded final commit retries, committed acknowledgement loss, denied writes, retained output, interrupted-save status, full storage fallback, and protection against forgetting a newer copy.
- Actual page handlers: work edits made after a submitted snapshot remain dirty; a failed save preserves its local draft; an unready global prompt cannot issue a save.
- Chromium and two real PWA builds with mocked Supabase/OpenRouter: worker update waiting, page-load recovery, progressive history, legacy mobile layout, multilingual search, scroll preservation, background generation, branching, lost atomic-start acknowledgement, retained answer after reload, recovery without another model call, actual editor input/draft retention, failed admin load, long prompt body save, and preservation of other global prompts.
- Existing 40 context/prompt-equivalence cases and 15 byte-equivalent disabled-work-combination fixtures remain in the complete suite. Browser checks now run in CI as well.

Observed browser scroll positions: edit `6424 → 6424`, generation `200 → 200`. With prompt settings delayed by 2 seconds in a mock API, history displayed in approximately 0.3–0.5 seconds. These are test observations, not production performance claims.

No real paid model requests or production conversation mutations were used for validation. Chromium checks do not replace testing on a physical iPhone. This patch does not claim to identify the underlying first LTE/Safari transport failure.
