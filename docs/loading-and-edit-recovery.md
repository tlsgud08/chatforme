# Loading, edit recovery and consistent user turns — 2026-10-26

The user reported slower work/session screens, delayed turn counts and first response text, frequent send/edit failures, and a false “changed in another screen” edit error. This change keeps the post-#133 features and transactional saves while fixing identified source-state and query problems.

## Behavior

- Variant selection reads the authoritative group **after** the server changes selection. Both selected and deselected messages receive their latest versions, rather than just toggling the local active flag.
- A failed edit can refresh a stale version once if body, command snapshot, visibility, selection, generation state, role, turn and group still match. A second version guard remains on the retry. Actual source changes retain the editor draft and are not overwritten. Generating, changed and unconfirmed-connection states have distinct messages.
- A lost generation-start acknowledgement is checked using the same user/draft IDs. Even a lost second reply can be confirmed without another model request. Unknown results preserve the input. Final/interrupted-answer retention and idempotent cost accounting remain in place.
- Session-list counts now use the same visible, active **user-message** count as the room and summary checkpoints. AI continuation/rerolls do not increment it; an already-saved user input still counts after model failure. No stored turn numbers are rewritten.
- Counts are cached by the account and sorted set of room IDs, with a 30-second freshness window. User insertion, deletion and failed/interrupted generation invalidate/update the relevant cache. Reordering the same rooms does not create a new count query.
- Work cards load separately from optional author names. Work and count caches preserve useful data across quick revisits. Counts remain independent of session-list rendering.
- Fresh work-combination/theme preparation runs while dialogue context is loading. All required data must still succeed before the model is called.
- Context SQL computes logical positions and total user turns on the same protected message scan. It no longer joins the protected table back to its positions. Returned rows, order, omitted-body markers and context hash remain identical.
- A maximum of 30 tab-local timing records survives reloads. Build time, operation, phase timings and outcome are retained; message text, keys, account/room identifiers and URLs are excluded. Send-error details include phase times, while normal toast text omits them. The provider body is unchanged.

## Rollback comparison

Compared the actual `fetchAllSessionMessages` from `dc0d056` (#133's parent) with the context function from `d3aefa4` and the new single-pass implementation. Each synthetic case ran 30 measured trials after warmup, alternating the direct and new read order. SQL ran in local PGlite with the actual schema/RLS; model payloads and complete reference/new JSON (including hashes) were checked for equality.

| Turns / rows | Pre-#133 full read: calls / bytes / median | Previous context: median | New context: calls / bytes / median |
| --- | --- | --- | --- |
| 20 / 40 | 1 / 144,243 / 2.15ms | 2.99ms | 1 / 45,527 / 2.29ms |
| 300 / 600 | 2 / 2,164,285 / 19.00ms | 149.64ms | 1 / 682,034 / 23.61ms |
| 700 / 1,400 | 3 / 5,050,285 / 49.08ms | 720.97ms | 1 / 1,591,554 / 51.54ms |

These are **local database/serialization measurements**, excluding actual network, mobile rendering and model waits. They are not a production improvement percentage. The full-history rollback was not selected: the single-pass query removes the measured database regression while keeping the reduced bytes and one request. The model messages remain equivalent.

Reproduce with `npm run benchmark:context`; the repository needs the historical commits `dc0d056564007da9de78ff84b4d30ad1d79c7a53` and `d3aefa421b4ac0b90eb1a9ba68d29ec4370ba673` available locally. This comparison does not use a paid model or production conversation content.

## Validation

Node 22.23.4:

- TypeScript, the complete `npm test` suite (27 top-level scripts), and production/PWA build passed.
- Existing 15 byte-equivalent disabled-combination requests and 40 optimized/full-history model-payload cases passed.
- Added 40 complete reference/new context JSON/hash cases: summary boundaries, keyword windows, reroll, hidden/legacy turns, inactive variants, logical gaps, permissions and reapplication.
- Real locked SDK tests cover stale versions with and without a connection failure, actual content/command/state conflicts, a second concurrent change, lost replies, generation guards and retained input. Writes are bounded; model calls are not retried by recovery.
- The count migration was tested with more than 1,000 rows, missing answers, continuations, variants, legacy turn zero, deletion, hidden/inactive rows, foreign/anonymous access and unchanged data on reapplication.
- Timing tests distinguish reasoning-only events from visible text, verify unchanged serialized provider bodies, reject sensitive content in records, and handle observer/storage errors without failing the operation.
- Two real production PWA builds with Chromium passed the browser suite, including old-worker update waiting, missing route chunks, progressive history, lost edit/start/final acknowledgements, saved-answer recovery, navigation during generation, branching, editor drafts and global-prompt load failure.
- Added browser cases: author lookup delayed by 2 seconds without blocking work cards; same-tab selection followed immediately by one successful edit request; genuine concurrent edit retaining the draft; theme preparation starting while the context request is held; no premature model call; phase records containing first event/text and final-save times.

The browser/API/model responses were mocked. Local browser verification used Chromium 153 with the project's Playwright client. Mobile/legacy viewport tests passed; physical iPhone Safari/LTE verification has not been performed.

## Database application

The two additive function replacements have been applied to the production project:

- `supabase/migrations/20261026000118_user_turn_counts_consistency.sql`
- `supabase/migrations/20261026002443_generation_context_single_pass.sql`

No conversation/summary/work rows, message IDs or stored turn indexes were bulk modified. Both function bodies match the source hashes:

| Function | Body MD5 | Verified properties |
| --- | --- | --- |
| session_conversation_counts | 267fcbcf1f03b4a742562ecb66620102 | STABLE, SECURITY INVOKER, fixed search_path, authenticated execution, anon denied |
| session_generation_context | ac113a4a9be71341a09cbf2d27871b93 | STABLE, SECURITY INVOKER, fixed search_path, authenticated execution, anon denied |

Native read-only verification switched to authenticated permissions and each owner's claims: **146 accessible sessions had zero count mismatches** against the room's user-turn definition. Context shape/hash checks passed for four owner samples. Role/claim changes were transaction-local. Existing security/performance advisory counts are unchanged.

The function signatures and context response shape support older clients. The frontend fixes require merging/deploying this branch and loading that build. A merged PR alone is not evidence that every open PWA tab is running it; each timing record identifies its build.

## Scope and remaining limit

Work combination and priorities, combined themes, 0/1-theme exclusion, day/night settings, showcase mode, icons, independent scroll, legacy/modern layouts, 450px preferences, TXT formatting, prompt/cache options and transactional saves are preserved. API-key storage and multichat flows are outside this change.

This change does not identify every cause of the user's original Safari connection loss or promise a particular provider first-token time. The phase timings separate preparation, headers, first event, first text and save on subsequent requests. Restore individual commits if a newly reproduced regression requires it; database function signatures remain compatible, so no destructive schema rollback is needed.
