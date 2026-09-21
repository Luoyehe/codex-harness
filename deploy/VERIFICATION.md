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
