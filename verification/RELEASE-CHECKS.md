# Release checks and test orchestration

These tools were written for the clean-room repository. No archived source, test,
build file or Git history was used. They do not establish release readiness by
themselves. The authoritative acceptance catalogue remains
`PROBLEM-ACCEPTANCE.md`, especially QA-01, QA-02 and QA-03.

## Source and Git-object scans

```text
node scripts/release-audit.mjs --source
node scripts/release-audit.mjs --git-objects
```

The default/source inventory is this repository's tracked and non-ignored
untracked files. Tracked ignored files are still scanned; tracked working-tree
deletions are absent from the release source. Normal ignored dependency trees,
runtime homes and evidence are outside this inventory. The separate Git-object
mode scans all objects available in this repository, including dangling objects,
and reports object IDs instead of historical content. It is not a claim about
unfetched remote objects. It does not modify or delete Git history.
Tree names use NUL framing and complete parent paths, including shared and
dangling subtrees. Missing ordinary tree/blob members fail the scan; gitlinks
belong to external repositories and do not trigger implicit network fetches.

Every selected regular file is streamed in full, including binary files and long
lines. There is no size-based pass or truncation rule. Read failures, a changed or
missing inventory entry, symlinks and special files produce `incomplete` and a
nonzero exit. No source file or fixture is exempted from content rules. Generated
paths and private file names produce separate `artifacts` entries. Matches emit
only path, line and rule; failures add a bounded error code. No matching content,
credential or OS error text is printed. `clean` exits 0; `blocked` and
`incomplete` exit 1. `skipped` and `unreadable` are separately represented.
Abnormally long separators after credential labels, Bearer prefixes or Windows
drive/home prefixes are conservatively blocked before the retained streaming
window is exceeded. This avoids chunk-dependent misses without retaining an
unbounded line or treating a layout overflow as a pass.

Rules cover private-key headers, known token shapes, long literal credential
assignments, bearer values, credentials in URLs, personal Windows/POSIX home
paths, private credential files and generated residue. This is a defined
heuristic check, not a proof that every possible secret encoding has been found.
Fixtures that need recognizable malicious strings construct them at runtime in
ignored isolated directories; weakening scanner rules or excluding tests is not
the remedy for a fixture finding.

## Affected selection and CI

```text
node scripts/select-tests.mjs --base <commit-id> --head <commit-id>
node scripts/select-tests.mjs --run unit --changed web/components/Composer.tsx
node scripts/select-tests.mjs --run deploy --changed deploy/install.py
node scripts/select-tests.mjs --run native --changed src/runtime/service.ts
```

`--changed` consumes the remaining arguments. The normal CI uses explicit base
and head commit IDs and `git diff --no-renames`: both sides of a rename remain
visible, and deleted source files retain their domain mapping. Unknown paths,
missing mapped regressions, deleted tests, privileged integration helpers,
dependency/build metadata, an unavailable base commit and an empty diff produce
`requires-full-audit` (exit 2). A selection covering the complete JavaScript or
repository test inventory also requires the audit gate. This status does not
authorize a full run automatically.

| Changed area | Selected behavior checks |
| --- | --- |
| `src/core` | Core, gateway and runtime regressions, including native boundaries |
| `src/gateway` | Gateway and gateway/native chain; manager client also maps Python deployment tests |
| `src/runtime`, `protocol` | Runtime and gateway regressions, including native smoke, gateway chain and approval suites |
| `web` | Browser behavior tests; web build configuration requires audit |
| `deploy` | `tests/deploy/**/test_*.py`, using Python, not Vitest |
| Existing test | That exact file; deleted tests require coverage review |
| Runtime fixture | Runtime regression domain |
| Release, selection, snapshot and test-runner scripts | Their tooling tests and dependent gate tests |
| Known CI workflow and source-inventory policy | Tooling checks; a new unmapped workflow requires audit |
| Recognized prose/audit evidence | `no-behavior-change`, explicitly no test pass |

The mapping is deliberately conservative within a domain, and it is a statement
of selected regressions rather than a line-coverage guarantee. If a group has no
affected test, its result is `not-affected`, not `passed`. Missing Python/native
dependencies or skipped platform tests produce `skipped` (exit 3). Test failures
exit 1. Python requires 3.11 or newer and can be located with
`HARNESS_TEST_PYTHON`; every selected Python file must collect at least one test.

`.github/workflows/affected.yml` runs source security, pinned dependency install,
type/build checks and selected JavaScript/Python tests on push and pull request.
Native changes also create independent Linux and Windows native jobs. Actions
are pinned by commit; Node is 24.15.0 and pnpm is 11.22.0. The initial push with a
zero/missing base fails closed and needs an explicit reviewed comparison. The CI
does not create audit records, run the full mode, call a paid model or access a
personal Codex home.

Native jobs fetch official platform packages for CLI 0.164.0 into ignored
`reference/runtime`, verify pinned SHA-512 archive integrity, extract them and
derive the single native executable path. The runner requires the explicit
absolute `HARNESS_TEST_CODEX_BIN`, checks independent package metadata and
executes `--version` with separate isolated home and temporary directories. It
never guesses a binary from PATH. Local package provenance must already have
been established, as documented in `reference/PROTOCOL-CONTRACT.md`; a matching
version string alone is not proof of an untampered binary. CI additionally checks
the distribution bytes. Missing preparation is a skip/failure, never a native
test pass.

## Full-audit gate

Only `node scripts/run-tests.mjs --full` is the full-test entrypoint. It takes no
test filters or override flag. `--targeted` accepts existing exact test files,
deduplicates them, and refuses empty, directory, traversal and complete-suite
selections. The Vitest invocation excludes unselected files because positional
Vitest filters are substring matches. JSON results must name exactly the selected
files and contain actual test assertions; skipped/todo assertions remain a
nonzero coverage gap. `.only` is disallowed.

The full mode snapshots the current source and validates the last three audit
rounds before executing either engine. It requires native and Python prerequisites
up front, then includes all JavaScript/native tests and the Python deployment
suite. Fixture tests of this orchestrator replace both engines with spies; they
never execute a real full suite.

The existing `verification/audits.json` stays schema version 1. Each of the last
three rounds must contain:

- A distinct `id`, consecutive positive `sequence`, current source `digest`,
  `complete: true`, and empty `findings` and `skipped` arrays.
- Ordered `startedAt` and `completedAt` timestamps. The next round starts only
  after the previous round completes; future completion times are rejected.
- All four scopes: `gateway-core`, `runtime-protocol`, `web-ux` and
  `deployment-release`.
- `reviewers`, each with a distinct `id` across the three rounds, assigned
  `scopes`, an `evidence` path and its `sha256`. Every scope must be covered by
  reviewer evidence in every round.

Each evidence file must be a regular JSON file at
`verification/audit-evidence/<round-id>/<reviewer-id>.json`. It records
`schemaVersion: 1`, `roundId`, `reviewerId`, the source `digest`, `complete: true`,
empty `findings` and `skipped`, the claimed `scopes`, a concrete `method` description
and nonempty repository-relative `inspectedFiles`. The gate validates identity,
scope, source and checksum consistency. Claimed scopes must identify inspected
files in their relevant areas: core and gateway; runtime and generated protocol;
web; deployment and release scripts/workflows, respectively. Reviewers must attach evidence from their
actual independent review; distinct strings and checksums cannot by themselves
prove that a human or agent really performed an independent audit. That remains
an auditable process obligation. Neither scripts nor CI manufacture those records.

Snapshot identity includes file names, executable bits and content hashes.
Only `verification/audits.json`, `verification/WORKLOG.md`, this report, regular
audit-evidence JSON paths and `verification/reports/*.md` are excluded to avoid
self-referential hashes. Other files under `verification`, including executable
source or configuration, remain in the digest. Any source fix changes the digest
and invalidates previous clean rounds.

## Evidence and remaining limits

The tooling regressions cover streaming large/binary input, split token/line
boundaries, error redaction, unreadable/nonregular paths, forced tracked ignored
artifacts, deletion, dangling Git objects, rename mappings, missing coverage,
metadata/full-inventory refusal, dependency skips, audit evidence tampering,
reviewer/scope/order violations, source changes and executable files under
`verification`. Python negative fixtures prove zero-collection rejection and
nonzero skip handling. They are independent test data in `.work`.

The implementation run executes only `tests/tooling/release-audit.test.ts`,
`tests/tooling/select-tests.test.ts` and `tests/tooling/run-tests.test.ts`, plus
source scanning and safe CLI/prerequisite checks. It does not execute the full
suite or claim three clean audits. The GitHub workflow has not been run on GitHub
in this session; its Linux/Windows package preparation and actual native jobs
remain CI integration evidence to obtain. Local source scans must be repeated
after the final integration snapshot. Browser/IME, online account/provider/MCP,
isolated Linux/systemd and migration acceptance remain separate evidence.

Latest local directed evidence (2026-10-25, before final integration freeze):
all 26 tooling assertions in the three files passed under Node 24.15.0; the
machine-readable report is `.work/test-results/run-hXvz5c/vitest.json`. The
Python zero-collection and skip fixture diagnostics are expected negative-test
output; no project deployment suite was executed by those fixtures. The source
scan at the preceding integration checkpoint read 1,501 files / 5,949,811 bytes
and returned `clean`, with zero findings,
artifacts, unreadable entries or skips. The actual independently prepared Windows
CLI prerequisite reported `codex-cli 0.164.0` from the required runtime location;
this check only ran `--version`, not native integration tests.

The full-audit gate now also requires each round's combined inspected-file inventory to cover every file in the immutable source snapshot (including tests, configuration, documentation and generated protocol), rather than merely one example from each area. Independent provenance/contract regeneration may establish generated-file inspection; it must be described in that reviewer's method and supported by actual evidence, not inferred from scope labels. The new partial-inventory negative fixture passed together with the other gate tests (11 checks in `.work/test-results/run-9yHMUi/vitest.json`).

### 2026-10-26 — v2.0.0 complete platform verification

Frozen source `96cde170ad50eb50753feb3229881ce609f6d3328691ffee5c479105803963d1` passed complete case reconciliation: **1,343 distinct cases**, 148 test files, zero failing cases and zero coverage gaps. Windows and Linux unprivileged full runs retain their original exit 3 for platform skips; the independent Linux root subset passed 69/69. All 236 skipped observations have an exact passing counterpart on the same source. Both platform process controllers confirmed cleanup and unchanged source. Detailed counts, immutable raw-evidence hashes and limitations are in [the full-test summary](audit-evidence/v2-release/full-summary.json). This is the user's explicitly authorized direct-to-full workflow; historical audit rounds remain unchanged.

### 2026-10-26 — persistent 120 deployment

The reviewed control update, provider-layer migration and application update completed for `crtest-rw-20261025` on 120. Native user configuration was preserved. Release `57434193056c8166dc4786f3686564ae7ee0cff0566a5fb7d63be81bb24047a8` contains v2.0.0 with Codex 0.164.0. Verification checked 20131 files plus permissions and managed units. Twenty-two real internal-CA HTTPS checks passed, including edge-to-gateway WebSocket, double authentication, file/Git helpers, bundled CLI diagnostics, attachment replay and native PTY disconnect cleanup. Four services remain active and enabled; the worker is connected and idle with no pending transaction.

[Deployment evidence](audit-evidence/v2-release/deployment.json) retains exact results. Browser visual acceptance is separately pending user handling of the internal-CA warning. Real commercial providers, public DNS/ACME and external firewall access were not exercised. GitHub publication is recorded separately.
