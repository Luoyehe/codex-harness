# Web implementation and verification

This is the new clean-room React implementation. Its visual reference was the public official page <https://www.deepseek.com/en/harness/>. No previous codex-harness source, assets, tests, configuration or Git history were consulted or copied.

The verification sections below retain their implementation-phase scope and results. Later repairs and release checks are recorded in [WORKLOG](../verification/WORKLOG.md) and [RELEASE-CHECKS](../verification/RELEASE-CHECKS.md); earlier counts and screenshots are not acceptance evidence for every later source change.

## Implemented connections

- Session login/logout, CSRF and per-document client identity; native browser WebSocket events and independent resource generations.
- Projects, thread search/pagination/archive/resume, safe Markdown and tool details, bounded complete history synchronization, streaming messages, plans, diff and token usage.
- A local new-chat draft becomes a server conversation only through one `conversation/start` intent carrying its first input. Existing threads use `turn/start`; no automatic write replay occurs on reconnection.
- Per-operation localStorage metadata and independent accepted/acknowledged proofs; `not_received` remains unknown until an explicit `operation/retire` request returns a durable not-sent fence. A positively read unknown receipt may be closed locally only after the current runtime generation is ready and the user explicitly accepts duplicate-execution risk after reviewing history and changes. Its acknowledgement tombstone is irreversible locally; the server record and unsent draft remain intact.
- Per-project/thread sessionStorage drafts retain text, options and uploaded attachment IDs. Accepted receipts clear only an unchanged draft revision. Settings expose saved drafts and an explicit discard step.
- Command/file/network/permission approval, structured secret/other answers and supported ordinary MCP form schemas. File approvals require matching thread/turn/item changes with paths, change kinds and diff fields before allowing; a grantRoot does not replace that review. Unsupported extension modes cannot be accepted. Typed form fields distinguish omitted values, false, zero, empty strings, empty arrays and permitted nulls. Inputs remain on RPC failure.
- Bounded attachments with authenticated image/text preview, download and removal; blob URLs are released on close/unmount and late reads do not create previews.
- xterm terminal code and CSS load with the application; opening its view and starting its process remain explicit. Incremental byte output, bounded serialized input, resize/close and ownership invalidation apply on disconnect/epoch/project changes. An open-attempt buffer retains authenticated owner events that precede its HTTP response, then applies only the matching terminal ID in order; overflow closes that attempt visibly. Terminal lifetime is connection-scoped.
- Actual model/default queries, account device-code login, rate limits, MCP OAuth, provider management, explicit private-HTTP key authorization, model discovery plus separate capability confirmation, service status/logs/restart. New conversations inherit project defaults; existing conversations inherit their current native settings, including accepted overrides. Receipt changes trigger a fresh resume/default read, with stale settings hidden while reading.
- Light/dark/system theme, mobile modal navigation, focus trapping/return and composed-key guards.

## Declared browser bounds

| Resource | Bound |
| --- | --- |
| History window | 2,000 turns, 8,000 items, 4,000,000 serialized characters, 80 pages |
| Opaque cursor | 4,096 characters, unchanged; loop detection before publishing |
| General directory | 50 pages / 3,000 entries |
| Pending/unacknowledged operation records | 200; no automatic deletion of unknown work |
| Drafts | 50 independent keys / 1,000,000 serialized characters total / 100,000 text characters per draft |
| Attachments | 8 per draft / 4 MiB per file; text preview 64 KiB |
| Terminal | 2,000 lines scrollback / 64 KiB queued input / 128 early events or 256 KiB per open attempt |
| Provider catalog | 1,000 discovered models; rendered in groups of 30 |

Exceeding history or draft capacity is visible and does not pretend synchronization or saving succeeded. Operation acknowledgement tombstones are retained to prevent late cross-tab responses from resurrecting dismissed entries; browser storage denial fails closed for new recorded writes.

## Targeted verification performed

The initial implementation ran 36 tests in 12 files in affected groups. The subsequent targeted audit repairs ran 50 tests in 13 affected files, all passing at their final execution. This second set covers operation uncertainty/retirement/local closure/cross-tab tombstones, late HTTP success after local closure, draft edits during submission, typed form interactions, file approval preview admission, early terminal output/exit and overflow, delayed close, current settings after accepted overrides, resource generations, actual manager logs arguments, and the parent's provider/resume regressions. No full-repository suite was run.

Affected files in that repair set: `operations`, `recovery`, `prompt-fields`, `prompts`, `terminal`, `drafts`, `defaults`, `resources`, `settings`, `provider`, `composer`, `resume`, and `events` under `web/tests/`. Initial test-authoring failures were a Testing Library whitespace matcher and the absent jsdom dialog API; those fixture issues were corrected and the relevant files rerun successfully.

Initial source checks: `pnpm exec tsc -p web/tsconfig.json` and `pnpm build:web`. Production output is `web/dist`. The original lazy terminal chunk was removed after actual HTTPS testing found that an expired outer authentication session could prevent its later loading and unmount the workspace. Terminal code and CSS now load with the initial application; creating the terminal view and process remains explicit.

Real browser visual/interaction QA used `web/tests/preview-server.mjs`: an isolated, read-only fixture with no worker, shell, model, real credentials or real project access. The fixture is not imported by the product and exits automatically after 15 minutes. Verified 1280×720, 320×480 and 390×680 layouts, dynamically added Other input, failed answer retention, draft restoration after reload, modal Tab wrap and Escape focus return, plus light/dark themes. The inspected browser error log was empty.

Screenshots are ignored verification artifacts in `reference/evidence/`:

- `web-welcome-desktop.png`
- `web-mobile-nav-320x480.png`
- `web-settings-dark-390x680.png`
- `web-conversation-390x680.png`

## Boundaries and follow-up audit notes

- Fixture browser QA does **not** validate production authentication, an actual CLI/model turn, paid inference, real provider credentials, account OAuth, external MCP authorization or Linux PTY behavior. Main-task gateway/runtime integration supplies separate evidence.
- Real operating-system IME composition was not exercised; composed events and keyCode 229 were tested programmatically, and normal modal keyboard behavior was verified in a browser.
- The new provider-catalog and attachment-preview components have targeted tests and type/build coverage. The saved screenshots predate those two additions and do not demonstrate their complete browser workflows.
- The parent's provider dirty-edit/conflict protection and runtime-generation resume changes were preserved and their affected tests passed during the repair set.
- The follow-up recovery, form, terminal and settings changes have component/application fixture tests and type/build coverage. No new real-browser screenshots, actual model turns, live provider calls or native PTY runs were performed for that repair set. Sticky native-setting semantics were checked against the freshly generated official `TurnStartParams` contract; the App interaction test uses an explicit protocol fixture, not a live model.
- This document records implementation-phase checks. It is not an independent full-repository audit and does not count toward the required clean-audit gate.

## Round 1 audit repairs

The first independent audit identified missing maintenance-release broadcasts, missing resource synchronization after a same-epoch worker reconnect, authentication expiry without a login transition, and archive actions derived from the sidebar filter. The repairs now publish maintenance release on both success and failure, advance the resource generation on upstream connection recovery, retain the mounted draft while a renewed login is required, and keep selected-thread archive facts separate from list filtering. When archive state is unknown, including a deep link outside the loaded list or an invalidated connection generation, the menu explains that state and offers explicit target-state actions. Recovery only queries saved operation IDs; it does not resubmit writes.

The gateway also registers a fresh worker owner for each browser connection before admitting worker RPC. Worker-channel and owner identifiers stay private to that transport. Terminal events reach only their registered browser owner and use an `owned: true` marker after routing. Lost registration or revocation confirmation fences the corresponding worker event channel; no owner registration is automatically replayed. Worker-channel loss closes browser event connections so every replacement receives a fresh registration.

Affected verification after these repairs: 67 passing tests across 14 explicitly selected files (gateway dispatch, HTTP, worker client; browser application lifecycle, session, events, defaults, operations, drafts, recovery, provider, resources, resume and terminal). Server and web TypeScript checks and both production builds passed. These checks include an unknown registration response, replacement-channel cleanup, a queued HTTP write crossing channel replacement, unauthenticated page renewal with a storage-denied in-memory draft, same-epoch read synchronization without write replay, and archive-filter independence. The authoritative repair details and limits are in `verification/audit-evidence/round1-fixes/control-web.json`. No full suite or new browser screenshot run was performed for these repairs.

## Round 2 control and web repairs

Late attachment deletion now updates the draft where deletion began, using its current text, options and attachments. It cannot replace another selected draft, and draft-change notifications identify their affected key so an unrelated unsaved input remains visible.

History uses the snapshot's item order and preserves authoritative live items. Active snapshots and deltas without an observed start have no shared event watermark; their text is displayed as separately labelled sources until a complete item arrives, without guessing textual overlap. Turn completion requests a fresh read even when no item-completed event arrived. That read clears stale merge protection and restores readiness from full history, while keeping the same conversation's known diff and token usage. Thread or runtime changes still clear those transient values.

Existing operation IDs reach the durable fingerprint and receipt check before live-connection admission. Accepted, rejected, pending and unknown identities retain their original facts during disconnection; changed parameters still conflict, and new worker dispatch still requires its authenticated browser lease.

Session, login, logout and RPC fetches explicitly request JSON and identify themselves as XMLHttpRequest so an outer access proxy can return 401 instead of a cross-origin login redirect. A proxy 401 is distinguished from a gateway authentication rejection. The login screen offers the current site's URL in a new tab and an explicit read-only login check in the retained page; it never follows an arbitrary Location response or replays writes. This keeps storage-denied in-memory drafts intact as well as stored drafts. Rejected administrator tokens retain their specific error message.

Targeted verification covered 70 distinct tests in ten selected files across gateway HTTP/dispatch and browser composer/drafts/history/conversation/session/application-lifecycle/operations/events. Overlapping reruns were not added to this count. Server and web TypeScript checks and both production builds passed. A newly authored hook fixture initially rebuilt its Api object on every render and was stopped; using the stable Api lifetime used by the application fixed that fixture, after which its targeted tests passed. This work did not run a full suite, a real browser, remote deployment, a commercial model, or external MCP. The parent task's separate real proxy/browser checks are not claimed as this component-test evidence. The portable repair report is `verification/audit-evidence/round2-fixes/control-web.json`.
