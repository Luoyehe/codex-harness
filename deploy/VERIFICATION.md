# Deployment verification and recovery contracts

These checks are read-only unless a separate script explicitly requires
`HARNESS_ALLOW_PAID_TESTS=1`. The checks below do not invoke a model or MCP tool.
`HARNESS_VERIFY_TIMEOUT_MS` sets a per-request deadline (default 15000 ms, range
1–120000 ms). A connection error, incomplete response, timeout or failed check
returns a nonzero exit status; diagnostic output excludes response bodies and
credentials.

- `node deploy/list-mcp-tools.mjs` lists the complete bounded MCP inventory,
  including pagination. A successful listing does **not** prove tool execution.
- `node deploy/verify-projects.mjs` checks the current workspace from `app/status`,
  the project inventory and directory listing. It does not create directories,
  add registrations or remove existing registrations.
- `bash deploy/verify-spa.sh` checks authenticated loopback HTML, referenced app
  assets and ready health. Use the installed `GATEWAY_CONTROL_HOME` or an explicit
  `GATEWAY_TOKEN`; it never falls back to a worker's old token. `PORT` defaults to
  8080. The optional HTTPS `EDGE_URL` gets an **unauthenticated** probe without the
  administrator credential. Redirects are not followed. For a deliberately
  self-signed fixture only, `EDGE_INSECURE=1` opts out of certificate verification.

## External Authelia acceptance

`setup-edge.sh` validates an external configuration with a local matching
Authelia executable and requires a live loopback health response with
`status: UP`. It does not restart an externally managed Authelia service.

Only a plain `access_control` section with `default_policy: one_factor` or
`two_factor` and no rules (or `rules: []`) passes the conservative static check
automatically. Rules, aliases and other YAML forms require administrator review
and explicit `AUTHELIA_POLICY_REVIEWED=1`. A simple deny-all or bypass default is
rejected. This helper is not a general YAML parser or a proof of effective
access control; Authelia's validator remains required.

The administrator must still check the real public URL in a browser: anonymous
access is blocked, an allowed account can log in and reach the app, and a denied
account cannot reach it. Check rules for the actual domain and all relevant
paths, methods and groups. Neither health nor a redirect proves these facts.
`SERVICE_MGR=none` skips service actions **and live health**; it is not a successful
live acceptance result.

## Failure and migration behavior

- The current updater first prepares locked registry dependencies in a separate
  DynamicUser with a fresh home, store and metadata cache. Its only project input
  is an inspected projection of the three manifests, lockfile and supported
  workspace settings. Lifecycle scripts and pnpmfile are disabled; candidate
  code, npmrc files, existing package caches and service credentials are not
  mounted. A bounded descriptor bridge transfers only the new store/cache.
  A second DynamicUser has `PrivateNetwork=yes` and installs from scratch with
  `--offline --frozen-lockfile` before the existing build and targeted checks.
  A dependency preparation failure occurs before stopping the service. An
  unconfirmed isolated-unit shutdown retains the transaction for inspection.
- The installed coordinator selects one of two fixed, read-only runner scripts.
  Candidate files cannot select or replace that entry point. Runtime identity
  includes the complete directory published by `install-runtime.sh`, including
  npm root metadata and the hidden module lock. The bridge checks the copied
  root-owned output's topology and manifest, and the coordinator compares its
  complete runtime fingerprint with the seed before acknowledging it. Links
  must remain inside the independently published artifacts/runtime or mounted
  store/cache directory. A root-exclusive acknowledgement, successful exit and
  confirmed unit shutdown are all required before validation reports success.
- This requires the new updater to be installed first. The published v1.2.1
  updater cannot bootstrap this dependency preparation step; use a reviewed
  complete source checkout and the documented stopped repair installation for
  the first migration to this development version. CLI preparation is separate.

- Full reset and uninstall first confirm service shutdown. Failure makes no
  edge change and deletes no data or service file. The following edge cleanup
  receives `EDGE_GATEWAY_STOPPED=1`; its success and rollback paths must not
  restart the gateway. If edge cleanup fails, maintenance stops, retaining data
  and service files; the gateway remains stopped for deliberate repair/retry.
- Device-code login also refuses to begin if the gateway cannot be stopped.
- Edge rollback attempts each restoration and reports partial recovery. If any
  restoration fails, its private backup directory is retained and its location
  is printed. Preserve that directory, inspect the reported service/configuration
  failures, restore deliberately, and remove the backup only after verification.
  A failing operation never becomes a successful exit merely because rollback ran.
- Privileged configuration changes require root-controlled ancestors and singly
  linked, root-owned regular configuration files. Worker-owned or linked legacy
  configuration is refused rather than automatically chowned; migrate it after
  deliberate administrator inspection. Mutable Authelia directories are created
  through descriptor-confined provisioning, never root-chowned in place. Legacy
  SQLite/notification migration runs after permanently dropping to `authelia`;
  a permissions failure requires deliberate migration, not a root fallback.

## Offline regression commands (Linux, ordinary isolated checkout)

For ordinary edits, select the actual changed paths and review the printed plan.
An unknown/deleted file or dependency-wide change fails closed: add a reviewed
mapping, or supply existing test paths with `--reviewed-tests path,path` after
reviewing the actual dependency/configuration impact. This explicit list covers
the unmapped paths printed in the plan; it is a human coverage assertion, not
an automatically proven dependency map. It does not remove mandatory native
checks. Generated protocol deletions use the same contracts as additions and
edits. Browser visual, keyboard and mobile checks are still required for UI changes.

`pnpm test:defaults` includes native default resolution and a no-turn lifecycle
regression: equivalent JSON key ordering must reuse the cache, cache eviction
must re-resolve, and all probe threads must unload promptly without changing
the user's idle policy. These checks use a fresh isolated CLI home and no model
inference. Changes to the resolver or generated protocol select them explicitly.

```sh
node scripts/targeted-tests.mjs --plan --files deploy/install-sandbox.sh
node scripts/targeted-tests.mjs --files deploy/install-sandbox.sh
```

`requiredNativeChecks` in the printed plan identifies additional checks. Linux
runs the selected offline CLI scripts with `CODEX_BIN` pointing to a separate
runtime of the pinned version; run `pnpm build` first. These scripts create their
own test homes and use loopback protocol fixtures. The systemd candidate fixture
requires a separate Linux/systemd environment, root or passwordless `sudo`, and
explicit `HARNESS_ALLOW_SYSTEMD_FIXTURE=1`; it uses a temporary unit and directories.
Missing prerequisites fail before test execution. Windows/macOS print these
checks as **NOT RUN** and still require the separate Linux result. CI prepares
the isolated CLI when selected and requires both the Windows and Linux jobs.

For a dependency/configuration edit, manual targeted CI accepts a base commit
and `reviewed_test_files` (comma-separated existing test paths). With no reviewed
coverage, an unmapped change fails; a successful unrelated test is not evidence
that a dependency update was reviewed. Do not select `audit_closeout` to bypass
this review.

The complete suite below is only for audit closeout, after three consecutive
complete audits of the final code find no new issues. Each earlier fix gets
targeted tests only. The CI `audit_closeout` input is an explicit confirmation
of this condition, not an automated proof that the audits took place.

```sh
PYTHONDONTWRITEBYTECODE=1 PYTHONIOENCODING=utf-8 node --test scripts/*.test.mjs
find deploy scripts -type f -name '*.sh' -print0 | xargs -0 -r -n1 bash -n
find deploy scripts -type f -name '*.mjs' -print0 | xargs -0 -r -n1 node --check
find deploy scripts -type f -name '*.sh' -print0 | xargs -0 -r shellcheck -S warning
python3 -c 'import ast,pathlib; [ast.parse(p.read_text(encoding="utf-8"), filename=str(p)) for root in ("deploy","scripts") for p in pathlib.Path(root).rglob("*.py")]'
```

Do not run a real edge setup, production maintenance, mounting/privilege attacks
or paid provider tasks as part of this regression suite. Kernel/systemd-specific
candidate-helper tests belong in the separately isolated integration environment.
