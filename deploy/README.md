# Installation and management

This is the clean-room deployment implementation for Ubuntu 24.04 and Debian 12, x64 and arm64. Python 3.11+, systemd with unified cgroup v2, sudo, e2fsprogs, mount, setpriv, bubblewrap (`/usr/bin/bwrap`) and ordinary user/group tools must already be installed. The manager does not modify existing unrelated services. Use a new instance name and unused ports for acceptance work.

The HTTPS migration and initialization/service recovery commands in this guide require version **2.1.1** or later. The earlier `v2.1.0` tag does not contain these additions.

Pinned application tools are Node **24.22.1**, pnpm **11.22.0**, and official Codex **0.164.0**. Node archives use embedded SHA-256 values verified against the official release checksum file. pnpm and Codex use embedded SHA-512 npm integrity values. The optional HTTPS edge uses Caddy **2.11.7**, pinned to official GitHub release asset SHA-256 digests. New installations use the built-in administrator account; no Authelia installation or authentication hostname is required. Existing Authelia binaries and identity material are retained only for migration recovery.

DNS-01 mode adds a separately built Caddy generation with six pinned provider plugins and Go **1.26.10**, exact source/module locks and official Go archive hashes. The plugins are AliDNS **1.0.29**, TencentCloud **0.4.3**, Cloudflare **0.2.4**, HuaweiCloud **1.0.1**, Route53 **1.6.2** and DigitalOcean **v0.0.0-20250606074528-04bde2867106**. The original edge binary and previously selected AliDNS-only generations are preserved. Binary capabilities and DNS credential selection participate in HTTPS recovery and remain intact across control updates.

## One-stop management menu

From a separate, reviewed checkout (preferably under `/root/codex-harness`), run:

```sh
sudo sh ./harness.sh
# Existing CLI options remain compatible:
sudo sh ./harness.sh --instance demo status
sudo python3 -B -m deploy.cli --instance demo manage
```

The menu selects an existing instance or accepts a new name. It combines installation, upgrades, HTTPS configuration, status and integrity diagnostics, logs, administrator username/password resets, restarts and recovery. `deploy/install.sh` also opens this menu when called without arguments. Enter `q` to cancel the current page.

For a new installation, it prepares missing distribution packages, packages the current source, asks for the administrator account, installs the loopback service and offers HTTPS setup. The DNS workflow accepts hidden credential input, a protected JSON file, or the existing retained credentials. Hidden input is written only to a temporary private file; the HTTPS manager imports it into its protected renewal configuration, then the input file is removed. The menu displays the domain/port and validation prerequisites before any HTTPS change. DNS records, ingress forwarding, provider permissions and outbound network connectivity remain operator prerequisites.

Upgrade uses the current reviewed checkout; it does not download arbitrary latest code or modify the active application tree. Fetch and review the intended version in that independent checkout, then choose upgrade. It packages the source and runs `control-update`, `config-layer-migrate`, then `update` in order, stopping at the first failure. Existing control ownership and recovery checks still apply. The source archive is retained after a failed operation so it can be used for recovery. Successful operations remove only the menu's own temporary archive.

Administrator reset asks for a new username and securely prompts for the new password. It clears two-factor enrollment and revokes existing sessions when loaded. A saved reset whose login cannot yet be verified is shown as pending, never as a successful login. Recovery choices use the existing journaled commands below; the menu never automatically retries an uncertain mutation or overwrites an existing installation. Advanced/non-interactive commands keep their original JSON output and stdin credential interfaces.

## First installation

From the trusted source checkout, create the source archive as an ordinary user. Only application source, generated protocol, root manifests and TypeScript configuration are included; local dependencies, build output, personal homes and `.env` files are excluded.

```sh
python3 -m deploy.cli pack-source --source . --output /tmp/harness-source.tgz
sudo python3 -m deploy.cli --instance demo install \
  --source /tmp/harness-source.tgz --origin http://127.0.0.1:3300 --port 3300 --username admin
```

Installation securely prompts for the administrator password and confirmation; `--username` defaults to `admin`. Passwords contain 12–256 Unicode characters, at most 1,024 UTF-8 bytes, and are not trimmed. For automation, `--password-stdin` accepts exactly one bounded line from a protected input source; never put a password in shell arguments or environment variables. Omit `--origin` for the interactive origin prompt. The gateway always listens on loopback. For a remote host, forward its loopback port with SSH and use the same browser origin configured at installation. Open that URL and sign in with the administrator username and password. SSH forwarding does not bypass application authentication.

The installer downloads verified upstream tools, fetches dependencies without lifecycle scripts, performs an offline installation, builds server and web, validates entrypoint syntax, and imports the stopped candidate. Before switching, a trusted non-root offline probe executes the exact imported CLI's version check, app-server initialize and model/list using a private fixture catalog, then verifies clean exit. The probe also checks token read denial, source write denial, blocked Internet sockets and the file-descriptor bound. A separate transient unit runs the candidate's `codex sandbox -c 'sandbox_mode="read-only"' -- /usr/bin/true` as the actual native UID/GID, with no capabilities, no-new-privileges, a private network and a fresh credential-free HOME/CODEX_HOME. These probes send no turns or external MCP calls. After startup, readiness requires both service processes running, gateway `/health` succeeding, and worker Unix `/status` reporting `connected: true`. A failed installation retains secrets and transaction records; it never silently replaces an identity on retry.

Install the distribution's `bubblewrap` package before installation or application updates. The actual-UID sandbox probe must succeed before publishing a candidate; merely starting app-server does not establish sandbox availability. On a `sandbox_prerequisite` error, inspect `journalctl -u 'codex-harness-demo-sandbox-*'` and the host's user-namespace/AppArmor policy. Correct the applicable per-program policy or prerequisite and retry the update. The installer never disables AppArmor or changes global user-namespace security settings to make this check pass. The probe's private runtime directory is managed by systemd; candidate files remain available after failure. Read-only management and recovery do not require bubblewrap to be present.

After initialization, resume a failed build or first startup with `update --source` from the reviewed checkout. The root-private `installation.json` records pending setup, a healthy release, and completed boot enablement separately. A confirmed failed first startup clears `current` and never creates a `previous` rollback target; uncertain stop retains its pointer and journal until a stop-confirmed retry. A partial `systemctl enable` or completion-record failure keeps the healthy release and retries enablement on update/restart. Once installation is complete, later updates and restarts preserve an administrator's disabled-unit choice. Older installations without this record are resumed automatically only when retained transactions prove there was no successful release. An older committed installation has no reliable enable-completion evidence, so its enablement is left unchanged; inspect `systemctl is-enabled` and explicitly enable the two instance units if recovering that older install's failed enable step.

For interruption inside initialization itself, use `install-resume --source` with the same reviewed deployment code and retained initialization journal. It accepts no replacement origin, account or password. `restore-services` separately restores services removed by a recorded uninstall. See [recovery and maintenance](RECOVERY.md) for the exact state distinction, offline backups and completed-candidate archiving.

The source archive is application input, not a replacement for the root manager. Updating the management implementation itself requires an operator to review and install a new trusted deployment tool; candidate source cannot replace the sudo-authorized helper.

Initialization checks every instance path, fixed service name, systemd definition/drop-in and sudo policy before creating identities or resumable configuration. A collision is not permission to take over the existing service. Resume, repair, control maintenance and uninstall recognize complete managed unit/sudo contents before stopping or deleting anything; unknown edits and overrides require operator inspection. The known control-maintenance and HTTPS-recovery condition drop-ins remain valid across trusted control updates.

## Updating the trusted control tools

Application `update --source` does not change the root-authorized management code. To update that code, review a separate checkout and place its deployment Python sources and fixed `deploy/caddy_dns_source` recipe in a root-owned directory with no group/other-writable ancestor (for example `/root/reviewed-harness`). Run these commands there as root. Do not run them from `/usr/lib/codex-harness` or a retained control generation. Do not edit a running control directory in place.

```sh
cd /root/reviewed-harness
sudo python3 -B -m deploy.cli --instance demo control-update
# After an interrupted or uncertain control update, restore its original tree:
sudo python3 -B -m deploy.cli --instance demo control-recover
# To revert a completed control update, use its returned transaction ID:
sudo python3 -B -m deploy.cli --instance demo control-rollback --transaction TRANSACTION_ID
```

These commands are operator-only, are absent from the gateway RPC allowlist, and accept no candidate archive or caller-selected helper source. `control-update` copies deployment Python source plus the four fixed, hash-verified DNS build recipe files (`main.go`, `main_test.go`, `go.mod`, `go.sum`) from its executing reviewed checkout and generates fixed launchers. It checks that source is exclusively root writable, rejects symlinked control trees, disables installed bytecode-cache writes, and imports the staged trusted package in a separate isolated Python process before stopping services. The checked-out code itself executes as root, so review and exclusive ownership must be established **before invoking Python**; the checks cannot make an untrusted checkout safe to execute.

Each transaction retains a complete old control tree, candidate manifest, original per-service activity/enablement and durable journal under `/usr/lib/codex-harness/.demo-control-transactions/TRANSACTION_ID`. Existing accounts, administrator token, provider settings, TLS material, identity database and encryption keys remain in place. The currently verified `control/edge` binaries are copied with their existing `*-binary.json` bindings, including during a Python rollback; later edge installation is not undone by rolling back older control code. A partially prepared or mismatched edge binary/record must be repaired separately before updating control tools.

Before any directory replacement, persistent per-service systemd conditions inhibit gateway, worker, Caddy and Authelia starts, including boot and dependency-triggered starts. The updater also saves both launcher files durably and atomically replaces them with small shell refusal scripts before stopping; a previously queued root management or native-launch invocation therefore cannot begin importing old modules during the directory switch. It stops and verifies all fixed instance services and known instance management/build transient cgroups, repeats enumeration, and checks `/proc` for remaining dedicated-account or installed-helper processes. Uncertain stop evidence retains both trees and these maintenance barriers without switching. The fixed control path stays a real directory; switching uses whole-directory renames while all consumers are stopped. A crash between renames may leave that path temporarily absent, so recovery must run from the separate reviewed checkout. Python module files are never overlaid into a running package. Root-owned legacy cache writes during shutdown are separated from code changes and included in the final stopped-tree manifest. Rollback uses the current fixed bootstrap around the retained old modules, disabling cache writes and rejecting pending control transactions before importing legacy management code.

Success restores only the originally active services and leaves each enabled/disabled state unchanged. A previously stopped worker remains stopped even when restoring a gateway which wants it. If both application services were active, gateway and native-worker readiness must pass before commit. An initialized instance with no successful application release and no active services can update its control tools without starting the application. Startup failure triggers stop-confirmed restoration of the previous code; uncertain recovery leaves the maintenance barriers and transaction for `control-recover`. Recovery restores the original tree and service set; it does not blindly finish a candidate switch. Ordinary CLI and helper operations refuse unfinished control maintenance. The per-service condition drop-ins remain installed with their marker files absent after success; do not remove barriers to bypass unfinished recovery.

The updater retains up to 32 preparation/transaction directories and never automatically removes a retained generation. When that limit is reached, an operator must inspect and archive completed records outside the managed transaction directory before another update. Keep the reviewed checkout available until acceptance is complete. Control updates do not migrate configuration formats or upgrade the application; changes requiring a new configuration schema need a separately reviewed migration.

## Provider configuration layers

New instances use `providerConfigLayer: "system-v1"`. Native owns its writable `CODEX_HOME/config.toml`; root provider defaults and complete provider requirements occupy separate immutable generation files. The worker binds those files only onto `/etc/codex/config.toml` and `/etc/codex/requirements.toml`. Existing `/etc/codex/managed_config.toml`, other files and relative reference origins remain available. The host's original files are never overwritten or removed. Missing bind targets are created only as empty root-owned 0644 files, with exclusive creation and conflict rechecking.

Host configuration, requirements and managed defaults must be ordinary root-owned, single-link files, immutable to native, already readable by native and at most 1 MiB each. Root-private host configuration is rejected rather than copied into a native-readable generation. Unrelated TOML values survive semantic roundtrip; conflicting provider selection, full provider definitions, catalog paths or managed defaults are explicit errors. No global policy is silently removed. Merged files are limited to 4 MiB each.

The requirements layer pins the selected complete provider definition, excluding user-supplied extra auth/header fields. ChatGPT uses a complete `harness_chatgpt` provider with OpenAI authentication, the official ChatGPT backend route, WebSocket support and ChatGPT-only login. The built-in `openai` provider cannot provide this boundary because its ordinary `openai_base_url` remains overridable. Model and effort choices remain ordinary defaults; the requirements layer enforces the routing and authentication boundary. API keys stay in root-private settings and the existing fixed native environment delivery path. Gateway OAuth and both Bedrock kinds require this system layer; selecting them on a legacy instance fails before creating a generation. Switch back to a legacy-supported kind before downgrading its configuration layer.

A separate fixed root `config-check` oneshot validates host fingerprints and generated bytes before each worker start. The worker asks PID1 to start that unit; the check runs without the worker's file binds. `ExecStartPre=+` alone still sees the bound namespace and is not used as a host-policy reader. The oneshot does not retain an active state, acquire the management lock, accept input or expose a sudo command. Host policy drift blocks startup until an explicit migration refresh succeeds.

For an existing instance, first update trusted control tools, then migrate from the reviewed checkout:

```sh
sudo python3 -B -m deploy.cli --instance demo control-update
sudo python3 -B -m deploy.cli --instance demo config-layer-migrate
# On interruption, restore the recorded original configuration:
sudo python3 -B -m deploy.cli --instance demo config-layer-recover --target old
# Explicitly finish the recorded candidate instead, when appropriate:
sudo python3 -B -m deploy.cli --instance demo config-layer-recover --target candidate
# Return to the legacy read-only user-config bind before an older control rollback:
sudo python3 -B -m deploy.cli --instance demo config-layer-rollback
```

Migration prevalidates host policy and sudo syntax, prepares a complete new provider generation, records exact unit/config/sudo bytes and original activity, installs persistent start conditions, and confirms gateway/worker shutdown before publication. It preserves the native user configuration byte-for-byte and does not modify old provider generations. Only the originally active services restart; enablement is untouched. Unknown stop retains the journal, both generations and start barriers. `repair` restores the old configuration for an interrupted migration; explicit candidate recovery is available when forward repair is required. Host policy must also permit the selected recovery direction. Completed configuration-layer journals have a 128-entry retention budget; provider generations use the separate reference-aware retention policy below.

Repeating `config-layer-migrate` verifies the current layer or explicitly refreshes it after compatible host policy changes. It rejects a tampered generated layer. `config-layer-rollback` restores the legacy three-mode native sudo policy, so workspace helpers become unavailable; native user bytes remain retained beneath the legacy provider bind. Control rollback refuses a target that lacks the currently selected provider-layer or workspace capability until this downgrade is complete. These are operator-only commands, absent from the gateway RPC allowlist. Management `status` reports `providerConfigLayer` as `legacy` or `system-v1`.

## Commands

All instance commands below run from the reviewed deployment checkout as root; `--instance` precedes the command.

```sh
sudo python3 -m deploy.cli --instance demo status
sudo python3 -m deploy.cli --instance demo verify
sudo python3 -m deploy.cli --instance demo logs --service worker --lines 100
sudo python3 -m deploy.cli --instance demo logs --service caddy --lines 100
sudo python3 -m deploy.cli --instance demo restart
sudo python3 -m deploy.cli --instance demo provider-read
sudo python3 -m deploy.cli --instance demo provider-prune
sudo python3 -m deploy.cli --instance demo provider-write < /root/provider-input.json
sudo python3 -m deploy.cli --instance demo models-sync < /root/catalog-input.json
sudo python3 -m deploy.cli --instance demo update --source /tmp/next-source.tgz
sudo python3 -m deploy.cli --instance demo rollback
sudo python3 -m deploy.cli --instance demo repair
sudo python3 -m deploy.cli --instance demo operation-read UUID
sudo python3 -m deploy.cli --instance demo uninstall
```

`verify` reads the complete selected release tree, including manifests, hidden lock metadata, all dependencies, executable permissions and symlink targets. It does not execute candidate code as root. `rollback` verifies the previous tree before stopping. `repair` recovers one interrupted release, provider, configuration-layer or HTTPS transaction to its recorded previous state; ambiguous multiple transactions require operator inspection. HTTPS recovery restores the previous unit files, origin, certificate selection, enablement and running services after confirming every involved cgroup stopped. `uninstall` stops and removes only this instance's units and sudo rule, and retains releases, accounts, state, token, provider generations and the paired Authelia database/keys. Permanent data removal is deliberately a separate operator action.

Operator CLI exceptions report an error code and message without a `delivery` assertion: a command may already have changed a pointer, started services or partially enabled units. Inspect the retained transaction and use the documented recovery path. The gateway RPC and operation receipts retain their separate `not_sent`/`unknown` contract.

New provider/catalog writes, HTTPS changes, control updates and uninstall share the unfinished-transaction gate used by release changes. Resolve the retained transaction with `repair` or `control-recover` first. Status and existing operation receipts remain readable. Only a never-committed first-start release can be retired by the stop-confirmed update/restart retry path.

Provider input is JSON on stdin; do not put API keys in argv or shell history. An example without a credential is:

```json
{"expectedRevision":"REVISION_FROM_READ","providerId":"new","name":"Coding Plan","kind":"zhipu-coding","apiKey":"ENTER_PRIVATELY"}
```

Kinds are `chatgpt`, `chatgpt-gateway`, `responses`, `zhipu-coding`, `bedrock-runtime` and `bedrock-mantle`. Save up to 16 connections and keep several enabled together. New conversations select a provider and model; existing conversations keep their provider. Changing the default affects new conversations. Each connection retains its own endpoint, key and model directory. ChatGPT device-code login appears inside its saved provider and is shared by the instance; it remains readable when an API-key provider is default.

A custom Responses provider needs a `baseUrl`; its default model is optional and can come from its discovered directory. Saving credentials succeeds even if discovery fails, with a visible directory error to retry. HTTPS is supported; HTTP is allowed for literal loopback, RFC1918 or IPv6 ULA addresses. Public HTTP, link-local addresses and HTTP DNS names are rejected. Sending a nonempty key over private HTTP additionally requires `allowInsecureHttp: true`. `apiKey: ""` explicitly selects no authentication; omitted keys are retained only for the same provider kind and exact endpoint. A new endpoint defaults to no key, and the literal string `"EMPTY"` remains a literal key. Responses compatibility includes streaming and completion; a Chat Completions URL is not equivalent. The provider's `supportsTools` setting defaults to true for Agent tasks and can be disabled for services without tool calling. This setting is a declared compatibility requirement, not a successful inference test.

`provider-read` returns `connections`, `defaultProviderId` and a collection revision. Add with `providerId:"new"`; edit with the saved ID; disable with `{expectedRevision,providerId,enabled:false}`; select a default with `{expectedRevision,defaultProviderId}`; remove with `{expectedRevision,removeProviderId}`. At least one connection must remain enabled. The one-stop update's `config-layer-migrate` step automatically converts legacy settings into connection `default`, preserving credentials, defaults and saved catalogs through the existing recoverable transaction. An empty Zhipu catalog is filled from the published vendor metadata without an external request. Provider saves and automatic model refreshes also accept the legacy format. Disabled or removed providers cannot silently take over old conversations.

Save a backup of the provider collection as a named profile in the provider panel. A profile retains the connections, default selection, models and keys in root-private storage. ChatGPT login sessions remain native-owned and are not copied into profiles. Up to 16 immutable profiles are allowed. Names must be unique and contain 1–64 Unicode characters (at most 256 UTF-8 bytes); explicitly delete an old profile before replacing it. Deleting a saved profile does not change enabled providers, and saving/deleting a profile does not restart services. Restoring a profile restores its entire collection through the normal revision-checked transaction and worker readiness check.

The CLI uses the same `provider-write` entrypoint with exactly one of these JSON actions, read from a private input file on stdin:

```json
{"expectedRevision":"REVISION_FROM_READ","saveProfileName":"Primary endpoint"}
{"expectedRevision":"REVISION_FROM_READ","profileId":"ID_FROM_READ"}
{"expectedRevision":"REVISION_FROM_READ","deleteProfileId":"ID_FROM_READ"}
```

These are three separate requests, not a single JSON document. Profile actions cannot include an alternative endpoint or key. `provider-read` exposes profile IDs, names, public settings and `hasApiKey`, never credentials. Current-provider public responses and durable management receipts use explicit field allowlists. Known active, retained-generation and saved-profile keys are redacted from service log reads.

Provider preparation automatically reclaims unused generations under the management lock. `provider-prune` performs the same maintenance explicitly and reports remaining/removed counts. It protects the selected generation and every provider reference in unfinished transactions, then retains the three most recent unused generations. Saved profiles contain independent complete settings and do not rely on a retained generation path. At the 128-generation bound, protected references are never evicted to make room. Unexpected material or unsafe links stop cleanup for inspection. An interrupted cleanup renames a generation into a private retirement name before removing its known files and can finish safely on retry. This command does not prune management receipts, configuration-layer journals, control generations, or failed build workspaces.

`chatgpt-gateway` requires an HTTPS Responses `baseUrl` and `gatewayOAuth` with HTTPS `authorizationUrl`, HTTPS `tokenUrl`, public `clientId` and `cookieName`. URLs cannot include credentials, query or fragment. Optional `redirectPort` is 1024–65535; omission leaves native OAuth to choose its loopback port. Only the official cookie delivery mode is exposed. Client secrets, arbitrary headers, scopes, resource overrides and root-supplied API keys are not accepted. A new gateway or any change to these targets requires `confirmGatewayCredentials:true`, confirming that ChatGPT credentials and requests may pass through that gateway. Unchanged targets do not require confirmation again for a model/effort edit. ChatGPT login and gateway OAuth remain separate native-owned credentials; the client initializes with explicit gateway OAuth so configuration alone does not initiate login. Each gateway definition pins both routes and cookie delivery. Gateway OAuth controls are available only for the default gateway, matching the native process that owns that authorization; selecting another card never authorizes the wrong gateway.

`bedrock-runtime` selects native `amazon-bedrock-runtime`; `bedrock-mantle` selects native `amazon-bedrock`. Both require an explicit commercial AWS `region` and a nonempty Bedrock bearer in `apiKey`. An omitted bearer is reused only for the same kind and region; changing either requires a fresh bearer. Fixed HTTPS endpoints use `bedrock-runtime.<region>.amazonaws.com/openai/v1` or `bedrock-mantle.<region>.api.aws/openai/v1`. Region syntax validation does not establish AWS availability, model access or account entitlement. Other AWS partitions, IAM profiles, credential processes, caller-selected endpoint/auth commands and browser paths are unsupported. Native Bedrock account setup does not replace this root-managed transaction.

The Bedrock requirement uses a fixed native-UID `native-launch bedrock-token` helper, which returns only the selected root-managed bearer. In a provider collection, the helper takes the saved connection ID and checks its enabled provider kind before selecting its credential. It outranks cached native AWS credentials; simply supplying an environment bearer would not. The helper is absent from the control account's sudo allowlist. Bearers stay out of generated TOML, ordinary reads and command arguments. Runtime and Mantle each support one saved connection; enabled Bedrock connections share one AWS region, matching the CLI's native AWS configuration. Native receives the explicit region, disabled metadata lookup and `/dev/null` AWS config/credential paths.

`models-sync` takes `{expectedRevision,providerId,automatic:true}` to refresh exactly one connection. ChatGPT, ChatGPT gateway and both Bedrock kinds return `source: "native"` without restarting; the client reads the selected native directory. ChatGPT choices remain empty until its shared ChatGPT login is available. Responses performs a provider-scoped GET of `baseUrl/models`, using only that provider's saved key. Discovery rejects redirects and bounds the request to 15 seconds, 1 MiB and 1,000 entries. Rich metadata is preserved; an ID-only response does not invent reasoning strengths, context windows or image support. Missing tool metadata uses the provider's explicit `supportsTools` setting; an explicit server `false` is respected. The synchronized directory is applied through the provider transaction. No inference request is sent.

Coding Plan uses the model directory published in the [official Zhipu Codex guide](https://docs.bigmodel.cn/cn/coding-plan/tool/codex), rather than assuming that Coding Plan offers an OpenAI `/models` endpoint. The UI labels this source. Its models and reasoning levels describe vendor capabilities, not successful credential validation or account entitlement. Refreshing an existing Zhipu connection installs that directory even when its default model was originally left blank.

Advanced directory editing accepts `{expectedRevision,providerId,confirmCapabilities:true,models:[{id,defaultEffort,efforts:[]}]}`. Optional model fields are `inputModalities` (default `["text"]`), `contextWindow` (default unknown), `supportsTools` (default false for manual rows), and `instructions`. Each connection has its own official CLI `model_catalog_json`, selected when starting, resuming or branching a conversation. Equal model IDs on different services cannot share capabilities. Resume rebinds the current catalog generation and preserves the saved model and reasoning effort. The native default is distinct from an optional override, including when the override list is empty. User confirmation is a capability declaration, not proof of provider availability or billing rights. The older preview-only `{expectedRevision}` call remains available for compatible clients.

Zhipu uses the official Responses URL `https://open.bigmodel.cn/api/v1`. Its four native MCP entries are search, reader, zread and vision. Remote MCP authorization uses the connection's named environment variable; local vision uses a fixed native helper to select that connection's key and start pinned `@z_ai/mcp-server@0.1.5` with `Z_AI_MODE=ZHIPU`. Additional Coding Plan connections receive distinct MCP names and credentials. MCP names do not grant approval or trust.

## Accounts, HTTPS and migration

The gateway owns a single administrator account. Account settings provide password changes, persistent login sessions, per-device revocation and optional TOTP with recovery codes. The gateway authenticates API and WebSocket requests using the same session. Model account authorization remains separate. There is no public registration or per-user project isolation.

To initialize an upgraded legacy instance once, use:

```sh
sudo python3 -m deploy.cli --instance demo account-setup --username admin
```

To deliberately recover an existing account instead, use:

```sh
sudo python3 -m deploy.cli --instance demo account-reset --username admin
```

Run `account-setup` after updating the application to an account-capable release. It refuses to replace an existing account. Choose one command for the intended action; do not run both in sequence. `account-reset` is an explicit recovery operation: a new bootstrap revision replaces the account password, disables its second factor and revokes existing sessions when loaded by the gateway. Both commands prompt securely; both support `--password-stdin`. A saved reset is never automatically undone or retried when verification fails. Check the returned `loginVerified` field and the gateway status before proceeding. Password changes made in the browser remain in the gateway database; re-reading the same bootstrap revision never overwrites them. The high-entropy `gateway-token` proves the gateway instance's identity to local operator commands and may initialize an account once in an upgraded instance; it cannot sign in after initialization.

For public HTTPS, point the domain's A/AAAA records at the actual ingress and forward public TCP **18443** to this instance's **18443** for browser access. Remove an incorrect AAAA record rather than advertising an unreachable IPv6 route. The default local listeners are HTTPS 18443 and HTTP 18081. Keep Caddy's state directory persistent and writable, its outbound DNS/HTTPS access available, and the server clock correct.

The default ACME mode needs only a hostname and the chosen listener ports in the command; it does not require a DNS API key. Before running it, arrange at least one of the following public validation routes:

| Validation method | Public route to Caddy with the default listeners |
| --- | --- |
| HTTP-01 | Public TCP **80** → local **18081** |
| TLS-ALPN-01 | Public TCP **443** → local **18443**, with TLS passthrough so Caddy receives the challenge handshake |

Caddy selects and retries the supported methods. The domain's advertised A/AAAA addresses must route correctly. A high browser port does not replace public port 80 or 443 for these challenges; keep a working validation route available for renewal as well as the first issuance. With those prerequisites satisfied, run:

```sh
sudo python3 -m deploy.cli --instance demo https --host work.example.com
```

If the ISP blocks both public 80 and 443, use DNS-01. This requires no public inbound validation port, although browsers still need the public business port. For a zone whose authoritative DNS is hosted by Alibaba Cloud DNS, prepare the credentials below and run:

```sh
sudo python3 -m deploy.cli --instance demo https --host work.example.com --username admin \
  --dns-provider alidns --dns-credentials /root/harness-dns.json
```

The command verifies a real built-in account login and revokes its temporary verification session before switching the edge. Each operator request authenticates the gateway with a fresh instance-key HMAC challenge before reading account state or sending credentials, using the same TCP connection with reconnection disabled. It prompts for the account password; add `--two-factor` when a TOTP or recovery code is required. Non-interactive callers can use `--password-stdin`, or `--credentials-stdin` with a bounded JSON object containing `username`, `password` and optional `otp`. These inputs never go in argv or ordinary command output. Caddy provides HTTPS and reverse proxying; its admin API is disabled, and proxy identity headers never grant application access.

Open **https://work.example.com:18443** from another network after activation. Both ACME paths use Caddy for issuance and renewal; no Certbot or cron job is needed. DNS-01 also creates and removes its temporary TXT records automatically, with no manual TXT updates. Choose the domain's authoritative DNS host, which may differ from its registrar; the selected account must manage that public zone. The HTTP redirect listener need not be exposed when using DNS-01. The first DNS setup builds the pinned Caddy/provider combination using a verified Go distribution and locked modules under the isolated build account. It does not run downloaded source as root or give the build process DNS credentials.

Inspect the proposed routes and certificate requirements before changing anything:

```sh
python3 -m deploy.cli https-plan --host work.example.com
# Or inspect the DNS-01 path:
python3 -m deploy.cli https-plan --host work.example.com --dns-provider alidns
```

`https-plan` requires no installed instance, root privileges, password, DNS credentials or network access. It uses only the supplied options, even if `--instance` is supplied; an omitted DNS provider means standard ACME for this plan. Its output explicitly leaves network access, credential validity and issuance unverified. Use `https-read` for an existing instance's actual retained selection. Neither command changes firewall rules, port forwarding or DNS records.

If the server requires an existing local proxy to download Go modules, add `--download-proxy http://127.0.0.1:PORT`. Only an explicit credential-free loopback HTTP proxy is accepted; shell proxy variables are not inherited. This option is for component preparation, not Caddy's DNS/CA traffic. Downloads still use pinned official distributions and checksum-verified modules; component tests and compilation run offline. Preparation phases are reported on stderr while stdout remains the final JSON result.

If the external TLS port differs from the local listener, set the browser origin explicitly. For example, public 24443 forwarded to local 18443:

```sh
sudo python3 -m deploy.cli --instance demo https --host work.example.com \
  --dns-provider alidns --dns-credentials /root/harness-dns.json \
  --https-port 18443 --public-origin https://work.example.com:24443
```

| Setting | Meaning |
| --- | --- |
| `--http-port 18081` | Optional local HTTP redirect listener; not required for DNS validation |
| `--https-port 18443` | Local TLS listener; forward the chosen public TLS port here |
| `--public-origin https://work.example.com:24443` | Exact browser origin, cookie/Origin checks and redirect destination; hostname must equal `--host` |
| Omitted `--public-origin` | Browser origin uses `--host` and `--https-port`, including a nonstandard port |

Explicit standard local ports remain supported with `--http-port 80 --https-port 443`. The integrated DNS providers are listed below; domains using other DNS providers can use default ACME when a public validation route is available, or operator-managed PEM certificates. The gateway backend stays on loopback; do not forward its port. See Caddy's [challenge requirements](https://caddyserver.com/docs/automatic-https#acme-challenges).

### DNS credentials

Use a dedicated API credential for the authoritative DNS service. All fields in the selected row are required; field names and case are exact. `https-plan --host work.example.com --dns-provider PROVIDER` shows the same schema without reading credentials or making API calls. Each platform is compiled into the reviewed binary; passing an arbitrary plugin or environment variable is not supported.

| DNS platform | Provider option | Required JSON fields | Credential type |
| --- | --- | --- | --- |
| Alibaba Cloud DNS | `alidns` | `accessKeyId`, `accessKeySecret` | Dedicated RAM AccessKey |
| Tencent Cloud DNSPod | `tencentcloud` | `secretId`, `secretKey` | Tencent Cloud CAM SecretId/SecretKey; **not** legacy DNSPod ID/Token |
| Cloudflare | `cloudflare` | `apiToken` | Scoped API Token; **not** Global API Key |
| Huawei Cloud DNS | `huaweicloud` | `accessKeyId`, `secretAccessKey` | IAM AK/SK |
| Amazon Route 53 | `route53` | `accessKeyId`, `secretAccessKey`, `region` | Explicit IAM key and region, e.g. `us-east-1` |
| DigitalOcean DNS | `digitalocean` | `apiToken` | Personal Access Token with domain scopes |

For example, Tencent Cloud input is `{"secretId":"YOUR_SECRET_ID","secretKey":"YOUR_SECRET_KEY"}`. Cloudflare and DigitalOcean each use `{"apiToken":"YOUR_API_TOKEN"}`, but their files are selected with different provider options and cannot reuse one another's managed credential generation. Huawei Cloud uses `{"accessKeyId":"YOUR_ACCESS_KEY_ID","secretAccessKey":"YOUR_SECRET_ACCESS_KEY"}`. Route 53 uses `{"accessKeyId":"YOUR_ACCESS_KEY_ID","secretAccessKey":"YOUR_SECRET_ACCESS_KEY","region":"us-east-1"}`. This integration requires explicit persistent credentials; it does not import host AWS profiles, EC2 roles or temporary session tokens. A region field alone is not evidence of successful operation in another AWS partition.

Use only the required DNS permissions and the narrowest resource scope supported by the provider:

- **Tencent Cloud DNSPod:** create a CAM subuser with API access and use its SecretId/SecretKey. The pinned ACME append/delete path uses `dnspod:DescribeRecordList`, `dnspod:CreateRecord` and `dnspod:DeleteRecord`; scope these to the intended domain resource, `qcs::dnspod::uin/ACCOUNT_ID:domain/DOMAIN_ID`. Follow the [DNSPod CAM guide](https://cloud.tencent.com/document/product/302/105690) and [resource scope reference](https://cloud.tencent.com/document/product/302/105719). The library's separate `ModifyRecord` method is not used by this path. Legacy DNSPod Token credentials use a different API and are not accepted by `tencentcloud`.
- **Cloudflare:** create one API Token with **Zone → Zone → Read** and **Zone → DNS → Edit**, restricted to the intended zone. Follow the [token guide](https://developers.cloudflare.com/fundamentals/api/get-started/create-token/) and [plugin's single-token contract](https://github.com/caddy-dns/cloudflare). For the default public `18443` URL use **DNS only** (gray cloud); the standard proxy accepts only its [documented ports](https://developers.cloudflare.com/fundamentals/reference/network-ports/). DNS-01 success does not establish proxy reachability.
- **Huawei Cloud:** the pinned append/delete path uses `dns:zone:list` plus `dns:recordset:list`, `dns:recordset:create` and `dns:recordset:delete`, scoped to the intended zone where supported. Review [DNS authorization actions](https://support.huaweicloud.com/api-dns/Permission.html) and attach the policy to the IAM user/group that owns the AK/SK. The pinned library signs requests directly and defaults to `https://dns.cn-south-1.myhuaweicloud.com/v2`; this integration keeps that endpoint and does not add project discovery or an arbitrary endpoint override. Do not use a private zone for public DNS validation. Other regional endpoints have not been validated by this integration.
- **Route 53:** the pinned default path uses `ListHostedZonesByName` for discovery and `ListResourceRecordSets`/`ChangeResourceRecordSets` on the selected hosted zone. The [plugin's broader IAM examples](https://github.com/caddy-dns/route53) also cover `ListHostedZones` and optional `GetChange` polling; this integration leaves that extra polling disabled and lets Caddy check DNS propagation. Use AWS [record-name/type conditions](https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/specifying-conditions-route53.html) to limit writes to the intended `_acme-challenge` TXT records. No hosted-zone creation or account administrator access is required.
- **DigitalOcean:** use a Personal Access Token with `domain:read`, `domain:create` and `domain:delete` for the DNS-01 record lifecycle, according to the [domain-record API](https://docs.digitalocean.com/products/networking/dns/reference/api/domain-records/). These scopes grant domain operations and are not a guarantee of restriction to a single TXT record; use an appropriately isolated account/team when a narrower resource boundary is unavailable.

**Alibaba Cloud DNS:**

Create a dedicated Alibaba Cloud RAM user with an AccessKey. For the pinned provider's DNS-01 create/remove workflow, grant `alidns:DescribeDomainRecords`, `alidns:AddDomainRecord` and `alidns:DeleteDomainRecord` on `acs:alidns:*:ACCOUNT_ID:domain/YOUR_DOMAIN`. Grant `alidns:DescribeDomains` separately on `*` for domain discovery. This does not require account-wide DNS write access or the account owner's AccessKey. The provider's general record-update action is not needed by this ACME workflow. See the [provider documentation](https://github.com/libdns/alidns/blob/master/README.md) and [Alibaba Cloud's domain-scoped policy documentation](https://help.aliyun.com/zh/dns/alibaba-cloud-dns-custom-permission-policy-reference-dns). Domain scope is not a restriction to one TXT record; a narrower boundary requires a separately managed challenge subdomain/delegation.

On the deployment server, save a UTF-8 JSON file outside the repository, owned by root with mode 0600:

```json
{"accessKeyId":"YOUR_ACCESS_KEY_ID","accessKeySecret":"YOUR_ACCESS_KEY_SECRET"}
```

For every provider, save the matching JSON as a private file such as `/root/harness-dns.json`, set ownership to root, and run `sudo chmod 600 /root/harness-dns.json`. Pass its path with `--dns-credentials`; never put credential values in command arguments. The tool copies the validated values into an immutable root-only generation. systemd supplies only the selected provider's values to the edge service; the gateway, worker and build account do not receive them. Caddy's configuration and diagnostic output reference the selection without printing the values. Keep the API credential active for renewal; deleting the original input file does not remove the managed copy.

Omitting both DNS options preserves an existing DNS selection when retaining ACME mode. Adding, removing or changing a DNS provider on an existing instance requires `https-migrate`; a change to another provider also requires its new credential file. Use `--dns-provider none` to explicitly return to standard-port challenges. Old credential and binary generations are retained for recovery, and upgrades preserve them. A control rollback is refused when its provider capability set does not cover the current selection or a pending HTTPS recovery snapshot. Original AliDNS-only tools qualify only for AliDNS selections, even if their generic DNS capability flag exists.

For planned credential rotation, create a replacement API credential with the same required permissions and put it in a new root-owned mode 0600 JSON file. Read `https-read`, then repeat the existing `https` hostname, TLS mode, local ports and any public-origin override with the new file. For an existing default-port DNS selection:

```sh
sudo python3 -m deploy.cli --instance demo https-read
sudo python3 -m deploy.cli --instance demo https --host work.example.com --tls acme \
  --http-port 18081 --https-port 18443 --dns-credentials /root/harness-dns-next.json
```

The selected provider is preserved and the new private generation is selected transactionally. A valid cached certificate may make activation succeed without a new DNS API request: successful TLS readiness does **not** prove the replacement key can create/delete TXT records. Verify the new key's permissions separately before revoking the old key during a planned rotation, then inspect subsequent actual issuance/renewal logs and certificate expiry. The tool performs no forced renewal or credential probe and reports `dnsApiAccessVerified: false`. Recovery material retains old credential generations, but a revoked key will no longer work if that generation is restored; reselect valid credentials after recovery. Do not delete managed generations manually.

| TLS mode | Trust and renewal |
| --- | --- |
| `acme` (default) | Public CA, system trust; Caddy manages issuance and renewal. With a supported `--dns-provider`, DNS API access replaces the public 80/443 challenge routes |
| `internal` | This instance's Caddy CA; install the returned `internalCaFile` deliberately on each client. Caddy manages its local certificates; this is not public CA trust |
| `provided` | Operator-supplied PEM certificate and key; replacement/renewal is the operator's responsibility |

For provided material, use `--tls provided --certificate /absolute/fullchain.pem --private-key /absolute/key.pem`. If its CA is not in system trust, also supply `--tls-ca-certificate /absolute/ca-bundle.pem`. Root copies the pair and optional public trust bundle into protected immutable generations. The trust bundle enables the deployment check; it does not install client trust. Repeat the same address/mode/port settings with both new PEM paths to replace the pair, or omit both paths to reuse it. Omitting both CA options preserves the selected trust bundle; use `--tls-system-ca` explicitly to return to system trust when replacing a private-CA certificate with a publicly signed provided certificate. The two CA options are mutually exclusive and apply only to `provided`. Never bypass certificate verification.

Caddy configuration validation happens before stopping services. After startup, activation requires a bounded real TLS handshake with the selected SNI, hostname/SAN, chain and validity checks, plus the selected gateway's HMAC identity proof. DNS ACME readiness waits up to 300 seconds, standard-port ACME up to 120 seconds, and other modes up to 30 seconds. Timeout fails activation and invokes recovery rather than declaring success. `Caddy active` alone cannot commit HTTPS activation. This check connects locally while preserving the configured Host and Origin; it does not prove public DNS, firewall/NAT reachability or browser trust from another network.

To change an already active built-in HTTPS hostname, TLS mode or ports, first read the current selection:

```sh
sudo python3 -m deploy.cli --instance demo https-read
sudo python3 -m deploy.cli --instance demo https-migrate \
  --expected-origin 'CURRENT_ORIGIN_FROM_HTTPS_READ' \
  --expected-https-revision 'CURRENT_HTTPS_REVISION_FROM_HTTPS_READ' \
  --host work.example.com --tls acme \
  --http-port 18081 --https-port 18443 \
  --dns-provider alidns --dns-credentials /root/harness-dns.json
```

Copy both returned values exactly; they prevent a stale plan from overwriting a newer selection. Supply all desired target ports/mode explicitly. Ordinary `https` preserves an existing address and rejects an accidental migration. `https-migrate` verifies the existing account, retains old configuration/TLS generations and switches transactionally. A changed browser origin requires signing in at the new origin. DNS-01 manages its temporary challenge records; it does not configure your A/AAAA records or router rules. For a legacy Authelia edge, first use the same-address migration below; `https-migrate` requires active built-in HTTPS.

Before changing the browser origin, copy unsent drafts and resolve outstanding operation receipts in the old page. Browser drafts and local recovery records belong to that browser and origin; the deployment transaction does not transfer them to a new domain, port or device. Server-side projects, conversations, account data and receipts remain retained.

Check certificate and renewal diagnostics with:

```sh
sudo python3 -m deploy.cli --instance demo status
sudo python3 -m deploy.cli --instance demo verify
sudo python3 -m deploy.cli --instance demo logs --service caddy --lines 100
```

The HTTPS result distinguishes `tlsVerified`, `instanceVerified` and `ready`, and exposes certificate `notAfter`, issuer, SANs and `daysRemaining`. `validation` explains the selected challenge and public-port requirements; `renewal.requirements` lists what must remain available. `renewal.automatic` reports the configured manager; `futureSuccessVerified: false` means no future renewal has been demonstrated. Check the Caddy log for challenge/issuance/renewal errors, and check the actual expiry again after a renewal. Do not delete the Caddy data directory or install a second certificate-renewal job over its managed certificates. The server-local result is explicitly marked `independentPublicAcceptance: false`.

Failures include `diagnostics` with mode-specific next steps. For `certificate_validation_failed`, check the selected hostname, expiration, server clock and trust chain. For connection failures or timeouts, check Caddy's listener, service log and port conflicts. For DNS ACME failures, check the selected provider's permissions, credential type/validity, authoritative TXT record propagation and outbound DNS/CA access. Check public 80/443 routes only when using the standard-port challenge mode. Read the exact CA error for CAA restrictions or rate limits; fix the cause before retrying rather than repeatedly creating orders or deleting Caddy state. `instance_proof_failed` means the response did not prove the selected instance; check the reverse-proxy target and origin. `legacy_identity_requires_migration` means TLS passed but the retained external identity gate prevents the built-in instance check. After local readiness succeeds, independently open the public URL from another network and verify browser login; none of the local checks claims that acceptance has already happened.

For an existing Authelia deployment, first update the reviewed control code and application, initialize and test the built-in account, then run `https` with the existing application hostname, TLS mode and ports. The command checks the current managed configuration, proves account login and snapshots the previous units, origin, certificate selection, metadata and enabled/running sets. A successful switch starts gateway, worker and Caddy, disables and removes the old Authelia unit, and preserves its identity database, keys and binary for recovery. The old authentication hostname is no longer used. Legacy `--auth-host`, `--cookie-domain`, `--email` and `--authelia-port` options exist only for matching the retained migration configuration; new setups do not need them.

A failed switch restores the prior configuration and exact enabled/running set after confirming every involved cgroup stopped. Uncertain restoration retains the journal and separate recovery conditions; run `repair` before another change. A gateway restart is checked again for initialized account support before committing the migration. Login, logout or restart never resubmits an uncertain application operation.

Ordinary application rollback accepts only releases declaring `harnessAuthentication: account-v1` after an account-capable release has been selected, an account bootstrap has been installed, or the edge has switched to built-in authentication. This prevents an old token-only release from silently bypassing account credentials or second-factor policy. The declaration is checked after complete release-manifest verification, and live account readiness is checked after startup. Returning to a legacy authentication architecture requires a separate complete operator recovery; the application `rollback` command does not perform that downgrade.

Under those same conditions, `control-rollback` also requires the retained, fully verified control generation to declare `authenticationGuard: account-v1`; an incompatible target is rejected before creating a new transaction or stopping services, so rolling back management tools cannot remove the account downgrade guard.

The same restrictions apply to failed-update recovery and `control-recover`/`repair`. An account-incompatible control recovery is refused before changing its transaction or service state. Application recovery first confirms services stopped, then refuses to select an old token-only release and retains the candidate and pending journal. This is reported as blocked recovery, never as a successful rollback. A failed first control upgrade on an instance still using a legacy application and without account bootstrap or built-in HTTPS continues to restore its original control tools normally.

When the previous version cannot safely restore account authentication, correct the reported runtime prerequisite and explicitly resume the original candidate. Choose the command matching the pending transaction:

```sh
# Pending application update:
sudo python3 -m deploy.cli --instance demo repair --target candidate
```

```sh
# Pending trusted control-tool update; run from the separate reviewed checkout:
sudo python3 -m deploy.cli --instance demo control-recover --target candidate
```

These commands accept no replacement path or arbitrary release identifier. They verify the complete candidate already recorded in the one pending transaction, confirm service shutdown, resume that same candidate and check readiness before committing the original transaction. A failed readiness check keeps the transaction pending and services stopped for another explicit attempt. Missing or modified candidate files are rejected; restore the exact trusted recovery material before retrying. The default recovery target remains the previous compatible version. `repair --target candidate` applies only to application-release transactions, not provider or HTTPS changes.

Back up the protected account bootstrap and a consistent gateway authentication database together with the existing instance recovery material. The gateway owns `auth.sqlite`; passwords use salted scrypt and sessions are stored as digests. Keep these backups private. Public DNS, client certificate trust, real browser login and model-provider access remain separate acceptance checks.

Versions before 2.1.0 could retain temporary MCP OAuth authorization links in operation receipts. New receipts keep only the handoff identity; receipt reads and new exports hide historical links while preserving the original operation and accepted state. Upgrading does not securely erase links already written to an old database, WAL or exported backup. Continue to protect retained instance backups as sensitive material.

## Security and failure contract

| Object | Owner / purpose |
| --- | --- |
| `/opt/codex-harness/INSTANCE/releases/SHA256` | root, complete immutable application + Node + official Codex platform package |
| `/etc/codex-harness/INSTANCE/auth-bootstrap.json` | root:gateway, 0640; account initialization/reset only; worker and IPC group cannot read |
| `/var/lib/codex-harness-instances/INSTANCE/gateway/auth.sqlite` | gateway private state; account, second factor and session digests |
| `/etc/codex-harness/INSTANCE/gateway-token` | root:gateway, 0640; internal instance proof and one-time legacy setup, never an account login bypass |
| `/var/lib/codex-harness-instances/INSTANCE/gateway` | gateway UID, 0700; SQLite receipt journal |
| `/var/lib/codex-harness-instances/INSTANCE/worker` | native worker UID, 0750; native sessions/auth/project execution; private files remain 0600 |
| `/var/lib/codex-harness-instances/INSTANCE/supervisor` | control UID, native read group, 0750; attachments directory 2750 and files 0640; native cannot write |
| `/run/codex-harness-INSTANCE/worker.sock` | control UID, gateway IPC group; 0660; native has no directory access |
| `/usr/lib/codex-harness/INSTANCE/manage` | root; fixed `rpc` sudo entry only |
| `/usr/lib/codex-harness/INSTANCE/native-launch` | root; control UID may sudo only to native UID with four exact modes; legacy downgrade retains three |
| root transaction/provider/identity records | private root paths; retained on uncertain recovery |

Gateway, control supervisor (`ch-INSTANCE-control`), native execution (`ch-INSTANCE-worker`) and candidate-builder UIDs are distinct. The IPC group is distinct from every primary group and excludes native execution. The Node worker runs as control UID; official CLI and model tools run as native UID. Native cannot connect to the control socket or use same-UID `/proc`, process-memory or FD duplication access against its supervisor. `ProtectProc=invisible` adds visibility restrictions; the design does not depend on a particular host Yama setting. Node starts with `--disable-sigusr1` so signal-triggered debugging cannot open another control route.

The worker service uses the IPC group as its effective service group, with control and native groups explicitly supplementary. systemd therefore creates its 2750 RuntimeDirectory as control:IPC for every Exec command; pre-start chgrp commands cannot establish this because systemd resets that ownership before the next Exec. The native launcher still switches to the fixed native UID/GID and clears supplementary groups. Restart/repair recognizes the exact earlier managed worker unit, migrates it only after confirmed shutdown, and reloads systemd before starting. Other unit changes are not silently overwritten.

The native UID has no sudo permission and no administrator token. The supervisor's only sudo entries run the fixed launcher as native UID, with exactly `version`, `app-server`, `resolve-project`, or `workspace`. The launcher validates its UID/GID, closes extra FDs, sets `no_new_privs`, ignores caller environment, and reads only root-managed native settings/provider environment. `resolve-project` checks the real directory as native UID with bounded JSON stdin/output. `app-server` bridges bounded stdin to a separate process group and acts as a Linux subreaper: EOF/signals terminate and reap descendants, including those that create their own process groups. Unconfirmed cleanup returns failure; runtime fails the supervisor and systemd terminates the entire service cgroup. Project selection does not create a filesystem security boundary; native is the single administrator's execution identity.

The dependency fetch stage receives only sanitized root dependency declarations, a constrained registry-only pnpm v9 lock and a trusted single-project workspace configuration. The source `pnpm-workspace.yaml` uses the JSON subset of YAML and must match an exact settings allowlist. The only approved overrides are `@z_ai/mcp-server@0.1.5>@modelcontextprotocol/sdk` to **1.32.2** and `zod` to **4.6.7**; the lock must record those same exact values. The trusted builder reconstructs this configuration separately in fetch and offline roots and binds each pnpm command to that root using `--dir` and `--workspace-root`. Arbitrary overrides, catalogs, hooks, other workspace members, Git/local/URL dependencies and config dependencies are rejected. The workspace participates in the source archive and dependency digest. Both stages discard inherited credentials/config, retain the 1,440-minute minimum release age, use a non-login build identity, root-owned toolchains, private temporary filesystems, a 2 GiB memory limit, 128 tasks, two CPUs and a 15-minute deadline. Fetch storage is bounded by a 4 GiB loop filesystem; offline build storage by 8 GiB. Offline install/build also receives a private network namespace and only AF_UNIX sockets. Lifecycle scripts and pnpm hooks are disabled in both stages. The compiler and Vite configuration execute only inside the offline stage.

The root importer accepts ordinary files, directories and internal non-dangling symlinks. It rejects hardlinks, sparse archive files, devices, external/cyclic links, changed inode metadata and oversized trees. Limits are 150,000 actual filesystem entries (including implicit parent directories and delayed symlinks), 3 GiB imported bytes and 512 MiB per file. Each archive member reserves all missing parents and its own entry before creating any of them; a later explicit header for an already implicit directory does not count twice. Physical archive member/header limits remain separate. Filesystem snapshots and verification consume directory entries only up to the remaining global count plus the first rejected entry, reserve pending siblings before descending, and sort only the bounded names. Archive input is additionally capped at 4 GiB; sequential decompression counts all consumed bytes, including skipped members, with a separate allowance for tar headers and padding. Before parsing PAX or GNU extensions, the shared importer limits each extension and effective/global PAX state to 64 KiB, aggregate extension payloads to 64 MiB, physical headers to 450,000 and consecutive extensions to 16. Ordinary PAX/GNU long names and links remain supported. gzip/bzip2 decoding bounds output chunks; XZ decoding also has a 128 MiB dictionary-memory limit. The parser discards completed member metadata instead of retaining a growing cache. These checks apply to application source and all pinned tool/edge archives. Filesystem snapshots use directory-relative descriptors with `O_NOFOLLOW` and confirm producer units stopped before import. A candidate-created ready marker is never a trusted success signal. Root creates the manifest and release identity independently after import. An existing release destination is never overwritten: an independently rebuilt identical candidate may reuse it only after verifying the entire root-owned tree and recorded manifest. A rename-before-manifest interruption is recovered only through the same exact-tree comparison. Duplicate candidate exports remain as bounded retained evidence. Release transactions snapshot both current and previous selection; failure and repair restore both. An interrupted update must be repaired before another update or restart, except for a first-start attempt with no healthy predecessor. Older journals without a previous-pointer snapshot cannot recreate a lost older rollback target; recovery removes a self-reference instead of inventing one.

pnpm's package store and public registry policy metadata are separate cache objects. Each stage uses its own explicit `cache-dir`. After fetch stops, the trusted importer snapshots both objects and records their manifest digests with the same dependency-input digest, then gives the offline stage independent copies. It never copies a whole user home or disables age/trust checks to make offline installation pass. Both source caches stay on the bounded fetch filesystem until import finishes; metadata copied into the offline stage remains inside that stage's disk quota. Isolated stage stdout/stderr go to the system journal with the existing 30-second/100-message rate limit, so an operator can inspect pnpm diagnostics; gateway log RPCs do not expose build-unit logs.

Preparation completes before stopping existing services. Switching and recovery require complete, consistent systemd state with both main/control PIDs zero. Failed/empty/contradictory state queries do not authorize cleanup. Every ambiguous failure retains evidence. The stop-confirmed recovery step updates the gateway journal under the gateway UID: pending operations become not_sent, dispatching operations become unknown, and the old activity barrier is cleared. Unknown operation records remain unknown and are never replayed. Recovery recognizes explicit complete schema contracts, including automations, automation runs, worktrees, indexes and retirement fences; unknown tables, views, triggers, changed columns/indexes or schema versions prevent any receipt update. Projects, automation/worktree state and retired-operation fences survive restart, release activation and trusted control restoration. Cross-language regression fixtures construct the real compiled JavaScript Ledger, recover it as its Linux owner, and reopen it with that same class; run `pnpm build:server` before those fixtures.

Successful build mounts are unmounted after import. Failed/uncertain stages retain their bounded workspaces and recovery files. At eight retained candidates, preparation refuses further work until an operator verifies and archives completed workspaces using the [stopped maintenance procedure](RECOVERY.md#archive-completed-build-candidates). A preparation record alone does not prove final unmount cleanup completed. No installer recursively deletes an uncertain running candidate or identity store.

## Gateway helper protocol

Execute without a shell:

```text
/usr/bin/sudo -n /usr/lib/codex-harness/INSTANCE/manage rpc
```

Write one bounded JSON object to stdin: `{method,params,operationId?}`. Allowed methods are `status`, `logs`, `restart`, `provider/read`, `provider/write`, `models/refresh`, `operation/read`. Unknown fields, paths, commands and environment overrides are rejected. stdout is `{ok:true,result}` or `{ok:false,error:{code,message,delivery}}`. Mutations require a canonical UUID and durable input digest; reused IDs with a different digest fail.

Mutations execute in a separate fixed root systemd unit, limited to 180 seconds, 512 MiB memory, no swap and 32 tasks. A gateway restart may disconnect the original caller; that does not kill the management transaction. Query the original ID using `operation/read`. Results contain `{operationId,method,requestDigest,gatewayRequestDigest,state,result?,error?}`; state is `running`, `completed`, `failed`, or an observational `not_received`. `requestDigest` is SHA-256 of canonical JSON `{method,params}`; `gatewayRequestDigest` uses `{method:"system/"+method,params}`. Only a completed trusted receipt matching the original gateway request can resolve an unknown result to accepted. A missing receipt does not prove an earlier request will never arrive. Receipt JSON excludes provider credentials.

Before writing a transient request, the helper validates the envelope, operation ID, method parameters, provider revision, recovery/ownership state and durable receipt budget. An existing receipt is replayed without staging or launching another unit. The executor repeats admission under the management lock before creating its receipt, so a change after staging cannot bypass validation.

The root-only request spool has a maximum of 32 retained request identities, 16 MiB aggregate file content and 1 MiB per serialized input/result, including the final newline. New admission reserves a complete result allowance before creating the input. One waiter holds an admission lease through launch and wait; an executor uses a separate file lock to read and publish without depending on that waiter. Input and output stay together until the unit is observed stopped and its cgroup is confirmed empty. Running requests are never stopped or deleted to make space. A disconnected waiter's completed material is collected by the next admission after those same checks. A late executor cannot recreate a collected request directory.

If state/stop confirmation fails, the helper retains all files, reports that recovery is required and blocks new staging. Unknown legacy files or already-exceeded retention limits also require operator inspection; they are not silently deleted. Recognized legacy UUID input/result pairs use the same stopped-unit checks. Retained provider inputs can contain credentials and remain private until confirmed cleanup. Spool cleanup never changes a durable receipt or converts a missing/unknown outcome to `not_sent`; after a launch or wait failure, query the original operation ID.

## Current evidence and compatibility

This section describes current helper contracts and retains the scope of earlier directed verification. Historical counts below do not assert that later source changes passed those same checks. Final source-specific test, deployment and publication results belong to [WORKLOG](../verification/WORKLOG.md) and [RELEASE-CHECKS](../verification/RELEASE-CHECKS.md); local transaction fixtures do not establish real account, public-certificate or provider acceptance.

The fixed native launcher also exposes `workspace` for a registered project root supplied by the gateway registry. The helper accepts versioned JSON `{version:1,root,action,params,operationId?}`; caller-selected binaries, environment and shell commands are rejected. Core read actions are `list`, `read`, `metadata`, `download`, `git/status`, `git/diff`, `git/refs`, and `operation/read`. File mutations are `write`, `mkdir`, `copy`, and `remove`; the runtime wrapper requires a durable operation ID and the final owner/write boundary before sending their input. These helpers are the backend foundation; their presence alone does not establish complete browser workflows.

File paths remain relative to the registered root and use Linux directory descriptors with `O_NOFOLLOW`. Symlinks, hardlinked files, special files, Git internals, native configuration and control storage are unavailable through this interface. Text edits and copies require a matching revision; creation requires an explicit null revision and an absent destination. Removal requires `confirm:true,recursive:false` and supports files or empty directories. Kernel no-replace renames capture the actual old inode before verification and never overwrite a newly occupied destination. Conflicts retain recovery material. The helper refuses cross-filesystem mutations instead of falling back to copy-and-delete.

Recovery records live outside projects at native `HOME/workspace-state`, keyed by the canonical project path and directory identity, then operation UUID. They retain previous content and unresolved results, and cannot supply paths that expand a later request's authority. Limits are 32 projects, 256 ordinary records plus one reserved discard slot and 64 MiB per project, 512 KiB per file, 1 MiB input, 2 MiB output and 1,000 directory/status/ref entries. Exceeding a retention budget requires inspection; no unknown operation is replayed or silently pruned. Ordinary helpers have a 20-second deadline and bounded Git process cleanup; transport failure after dispatch remains unknown. Git queries use fixed arguments, a clean environment, disabled hooks/fsmonitor/external diff/text conversion, and no network protocols or recursive submodule operations. Status and diff use a private Git view with a copied, bounded index and fixed configuration so repository clean filters cannot execute during content comparison. Custom filter/autocrlf conversion is intentionally absent from that view; results describe raw workspace bytes. Recursive removal and watches remain outside this interface.

`recovery/list` and `recovery/read` inspect retained `before`/`next` slots with content revisions and a manifest. `recovery/restore` requires an explicit current-project destination, source operation/slot/revision and the destination's current revision (or null for an absent path). It copies the selected retained version, preserves the original backup, and captures any replaced destination as the new operation's backup. Empty directories and bounded binary files are supported. Paths stored in native-owned journals never authorize a restore destination.

`recovery/discard` requires the current manifest and `confirm:true`. It releases only payloads belonging to a completed source operation, captures and revalidates all selected inodes before deletion, and records a discard marker. Failed or unknown sources retain all recovery materials. Discard reserves only a small receipt allowance and has one fixed extra slot, allowing cleanup when ordinary record capacity is full. A failed or unknown discard keeps that slot occupied until inspection; new requests cannot accumulate unlimited cleanup records.

After the gateway durably accepts a workspace operation, its trusted supervisor may send the internal `operation/ack` action with the exact operation ID and helper request digest. This action is absent from browser RPC methods. Native marks only a matching completed successful receipt as acknowledged. Receipts with workspace payloads or Git-index backups remain; acknowledged receipts without recovery material can be reclaimed. Discarding the last backup makes such a receipt eligible on the next admission. Missing receipts are idempotently acknowledged for cleanup retries, never used as success evidence. A supervisor-private witness binds the gateway digest, registered project/root, helper digest and precise result identities before an unknown gateway receipt can be reconciled without resending. Gateway acceptance and supervisor proof remain authoritative; native-owned files and missing records cannot establish a write's outcome.

The worktree helper adds `worktree/create`, `worktree/read`, `worktree/attach`, `worktree/archive` and `worktree/restore`. Creation accepts only HEAD, a full local ref or a commit id and uses the durable operation UUID as its worktree id. The fixed destination is native `HOME/worktrees/<id>`. It prevalidates bounded raw Git objects before creating a detached worktree, then materializes those bytes without checkout filters or hooks. Later operations require a supervisor-private binding to the original registered repository, Git common-directory identity, linked Git directory and checkout inode. Native-owned journals cannot grant a new binding, expand a path or register a browser project. The gateway/runtime integration additionally owns project registration, references, execution idleness and positive receipt proof; helper tests alone do not establish those application guarantees.

Archiving requires an exact current snapshot revision and confirmation. It locks the linked worktree with its own reason, atomically moves the entire checkout to native `HOME/worktree-state/<id>/checkout`, and repairs Git's backlink. Dirty files, staged index, untracked files and ignored files remain together. Archive deactivates the path and **does not reclaim disk space**. Restore moves that same directory back with no-replace semantics and repairs only the validated linked worktree. Primary, shared, nested, symlinked, hardlinked, user-locked or ambiguous worktrees are rejected; interrupted moves retain the entire checkout for explicit recovery. No recursive checkout deletion is implemented. Limits are 32 retained worktrees, 10,000 tree entries, depth 32, 128 MiB total file content, 8 MiB per file and a 75-second helper deadline (90-second caller timeout). An unknown unbound create still requires inspection and cannot automatically authorize attachment.

`resource/skill/read` is an internal read-only action. The supervisor selects an exact `SKILL.md` from a fresh native skill catalog using the browser's skill id. The helper independently permits only the registered project, native `HOME/.agents/skills`, `CODEX_HOME/skills`, `CODEX_HOME/plugins/cache` and `/etc/codex/skills`; other native configuration and control directories remain forbidden. Every path component is opened without following links, and the final single-link regular file must be stable UTF-8 without NUL, at most 512 KiB. Read success does not imply that skill instructions are trusted or should execute. Project skill creation uses the existing durable `mkdir` and create-only `write` operations, retaining each operation receipt and refusing existing filenames.

`resource/directory/resolve` accepts only a path relative to the selected registered project and returns its canonical path and directory identity. `resource/plugin/preview` inventories such a directory with a revision over relative paths, content hashes and modes. It rejects nested `.git`, links, hardlinks and special files, and caps the tree at 512 files, 1,024 directories, depth 16, 2 MiB per file and 16 MiB total. These are read-only preflights. A subsequent native marketplace/share RPC reopens its path, so this is not an atomic snapshot or an isolation boundary against concurrent writes by the same native UID. Preview alone sends no files externally; sharing requires its separate explicit action and current preview check.

`download` requires the current file revision and returns base64 for an ordinary single-link file up to 8 MiB. `metadata` returns the revision and `downloadable` flag for files within that limit; the smaller 512 KiB text preview/edit budget remains unchanged. Downloads are read-only, use the same protected-path checks, and have a 12 MiB serialized output limit. They neither consume a write receipt nor disclose native configuration through an alternate path.

`git/status` includes `commitState` with the current HEAD (null for an unborn branch), symbolic target, HEAD-file revision and complete bounded index revision. `git/commit` requires those selected versions, an explicit author name/email and a message of at most 64 KiB. It commits only the staged index, preserves unstaged workspace bytes and the original index, and refuses empty commits, unmerged indexes and ongoing merge/rebase/cherry-pick state. The gateway treats it as an idle configuration mutation with a durable receipt. There is no implicit staging, amend, signing, hook execution or network operation.

Commit creation uses a copied index and fixed Git configuration for `write-tree` and `commit-tree`. Publication holds an owned `index.lock`, asks Git's `update-ref --stdin` transaction to prepare an expected-old-HEAD compare-and-swap, then checks HEAD-file/index versions again while Git holds the ref locks. This second check starts no sibling process: all one-shot Git helpers require exclusive ownership of their child tree, because shutdown also collects detached descendants. Only after that check and a durable candidate record does the helper send the commit instruction. The original index is never replaced, including on failure. A lost result stays unknown; a diagnostic candidate commit is not a positive acceptance witness. Unconfirmed shutdown retains the owned index lock for inspection, and a replaced or foreign lock is never removed. Failed object creation may leave normal unreachable Git objects; the helper does not run garbage collection. These locks coordinate ordinary Git writers; they do not isolate concurrent arbitrary filesystem writes by the same native UID.

`git/stage` and `git/unstage` select at most 32 explicit paths and require the current HEAD, HEAD-file revision and index revision. Stage also requires each file revision, including executable mode, or explicit deletion with an absent file. A copied index consumes raw bytes without filters, hooks, signing or network. Unstage restores only selected entries from HEAD; neither operation recursively stages directories or changes workspace bytes. Unexpected changes to other index entries are rejected.

Index publication holds an owned `index.lock` and a prepared Git verify-HEAD transaction. While Git holds its ref locks, the helper rechecks descriptors, captures the actual old index with no-replace semantics, verifies that captured version and publishes the new index without overwriting an occupied destination. An external replacement is preserved alongside the retained versions; failure remains unknown. The helper never starts a second Git child during this prepared transaction.

`git/index/recovery/list` and `read` inspect a separate native `HOME/git-index-state` store. It keeps a self-contained prior index, the actually captured index and the candidate index, with source revisions and a manifest. Restore requires current HEAD/index versions and an exact source slot/revision; discard requires a completed source, current manifest and confirmation. Fixed repository metadata determines the destination, never a native-owned journal path. Limits are 32 projects, 64 payload records and 128 MiB per project, with a 16 MiB index limit. Payload discard frees its index-retention slot while the ordinary operation receipt remains. Failed or unknown records require inspection; corrupted current indexes may require operator repair rather than automatic restoration.

All Git operations require either the registered root's actual `.git` directory or a linked worktree whose `.git`, common directory and Git backlink agree. A `.git` file pointing at a foreign primary repository is rejected, including when Git reports the selected working directory as its top level. Standalone `--separate-git-dir` layouts without a genuine linked-worktree backlink are unsupported. Managed-worktree mutations additionally require the supervisor-private binding described above.

`search` performs bounded filename or UTF-8 text matching inside the selected project. It skips protected metadata and links and limits traversal to depth 24, 10,000 entries, 32 MiB of content and three seconds. It returns explicit completion and reason fields; an incomplete response does not prove that no other match exists.

The pinned protocol exposes `hooks/list` with each hook's source, current hash, managed status and trust state; it has no hook trust/write RPC. The [official hooks documentation](https://learn.chatgpt.com/docs/hooks) binds trust to the exact current definition and directs users to CLI `/hooks` for review, trust and disabling individual non-managed hooks. Changed hooks need review again, plugin installation does not grant trust, and managed hooks cannot be disabled by the user hook browser. The harness does not modify an undocumented trust store or enable the hook-trust bypass flag. Browser hook inspection must not be presented as completed trust management.

Run only the affected deployment tests for a deployment change. Ordinary checks run without elevated privileges:

```sh
python3 -B -m unittest discover -s tests/deploy -p test_deployment.py -v
python3 -B -m unittest discover -s tests/deploy -p test_https.py -v
python3 -B -m unittest discover -s tests/deploy -p test_install_recovery.py -v
python3 -B -m unittest discover -s tests/deploy -p test_control_update.py -v
python3 -B -m unittest discover -s tests/deploy -p test_request_spool.py -v
```

The real root-ownership transaction fixtures live separately in `tests/deploy/root/`. Run a selected file only on a disposable Linux test host, for example `sudo /usr/bin/env -i PATH=/usr/bin:/bin /usr/bin/python3 -B -m unittest discover -s tests/deploy/root -p test_control_update.py -v`. These fixtures create their own temporary files and substitute service/process management commands; they still enforce actual root file ownership. They explicitly skip outside Linux root, and the test runner treats that skip as a nonzero coverage gap. The ordinary control-command, HTTPS rendering, installation-state and preflight checks remain unprivileged.

Affected selection reports `deploy` and `deploy-root` as separate groups; changing either half of a split fixture selects its counterpart too. CI runs ordinary deployment checks as the hosted runner user, then passes the exact selected root-file list to a separate disposable `ubuntu-24.04` job. That job checks the hosted environment, uses only the OS-installed `/usr/bin/python3` through a clean `sudo` environment, and refuses missing, duplicate, empty or non-root-fixture selections. It does not install dependencies as root. Every selected test must run without skips. The full-test inventory still contains both groups and retains the three-audit gate; separating identities does not reduce full coverage.

The sealed DNS Caddy package also belongs to the `go` affected-test group and the full inventory. Its behavior tests, executable compilation, and version/plugin probe run on both ordinary Linux and Windows CI runners. Prepare the fixed Go toolchain and authenticated public modules explicitly with `python -B scripts/prepare-ci-go.py`, then run `pnpm test:targeted deploy/caddy_dns_source/main_test.go`. Preparation uses only official downloads; an existing task-owned archive and module cache can instead be supplied with `--archive` and `--seed-cache` for offline preparation. Each execution copies those modules into a separate test cache, isolates its home, disables toolchain downloads, and runs verification, tests, build, and probe offline. Missing preparation is a nonzero prerequisite skip; failed, incomplete, or uncompiled Go evidence cannot pass CI reconciliation. No deployment, service mounts, DNS credentials, or live certificate orders are involved.

The control-update fixture tests cover real directory/journal transitions with substituted systemd/process operations: independent active/enabled sets, initialized but never started instances, transient-stop coverage, uncertain stop and escaped-process retention, startup/health/reload failures, power loss around rename/journal boundaries, integrity failures, persistent recovery barriers, source-argument rejection, exact instance-name matching, and preserving edge binaries during update and rollback. These tests do not establish real systemd condition behavior, `/proc` visibility or recovery across an actual host reboot; validate those on the disposable Linux instance before production use.

The earlier Windows deployment run, before the identity-based test split above, passed 35 tests and explicitly skipped 4 Linux-only tests (39 selected). It covered independent transaction fault injection, complete runtime manifest changes, archive hazards, provider revisions/defaults/secrets, stopped-journal recovery, method/group boundaries, TLS modes/ports, real local HTTP model discovery, redirect rejection, disconnected-worker readiness rejection, bounded project resolution, exact workspace/override rejection and source-archive binding. The skipped cases include native pipe backpressure and real subreaper cleanup of a descendant that escapes its original process group. Eight additional HTTPS transaction tests passed with local files and substituted system/edge commands: paired certificate publication, validation failure before stop, unit-write/reload/start/health/enable failures, unknown-stop retention, interrupted-transaction repair, initial edge activation and previously stopped services. Nineteen additional initial-installation tests passed: enable and completion-record retry, failed-first-start pointers and legacy journals, existing disabled state, verified release reuse, interrupted manifest publication, interrupted upgrade guards, restoration of both release pointers and operator CLI error semantics. Windows substitutes pointer creation/reading because its test token cannot create symlinks; Linux uses the actual symlink implementation. These are file/transaction fixtures with substituted service commands, not real systemd boot acceptance. The identity database/key bytes in the HTTPS tests are opaque fixtures; these checks do not establish real certificate validity or external login. The trusted runtime probe also ran against the official Windows Codex 0.164.0 binary in an independent OS temporary home: version, initialize, exact fixture model/list and clean process exit passed, with zero turns. A separately generated catalog with a native default absent from the override list was accepted by the same fixed CLI.

These Windows checks do **not** prove Linux systemd execution, UID isolation, network namespaces, loop mounts, real browser account login, external MCP, or paid provider operation. These must be executed on the isolated Linux acceptance instance; a mock is not a replacement. After installing a disposable `crtest-*` instance, run `sudo python3 tests/deploy/linux_isolation.py --instance crtest-NAME` for real UID/token/source/network/disk/FD/child-process boundary evidence. The probe opens but never reads the token file if a boundary fails; its only network connection is to its own loopback listener.

Run `sudo python3 tests/deploy/linux_native_boundary.py --instance crtest-NAME` against that installed disposable instance to exercise native UID socket denial, supervisor `/proc` memory/environment/FD denial, `pidfd_getfd` and `process_vm_readv` denial, read-only attachments and the actual control-to-native sudo version command. It performs no turns and reads no secret contents. These Linux boundary checks remain unverified until that script runs successfully.

A pnpm 11.22.0 flag probe exposed a new isolation defect during development: running `pnpm --dir` in a nested repository fixture without its own workspace discovered the ancestor workspace and disturbed its `node_modules` links. Source and lock files were intact; the root agent restored the dependency links. No cleanup command was involved. `--ignore-workspace` avoided ancestor discovery but also ignored security overrides in pnpm 11. The current builder creates a complete, allowlisted workspace in each isolated stage before invoking pnpm with explicit `--dir` and `--workspace-root`; it never supplies a candidate-controlled general workspace. Both stages use a clean environment and live outside any repository under a dedicated `/var/cache` tree. Package-manager probes must use a separate operating-system temporary directory or the isolated Linux acceptance path, never a nested repository fixture.

Both real fetch/install commands also use `--config.package-import-method=copy`. An independent Windows OS-temp fixture fetched pinned `@iarna/toml@2.2.5` with pnpm 11.22.0 and installed it offline using the actual shared command flags: all 46 regular application files had link count 1. The initial diagnostic capture encountered a Windows text-codec error; a UTF-8 offline verification completed successfully without touching repository dependencies. Linux full-tree import still enforces single-link files and must pass on the real candidate filesystem.

The vision package remains the official `@z_ai/mcp-server@0.1.5`, with its vulnerable transitive SDK/Zod versions replaced by the exact reviewed overrides above. A real local stdio probe initializes the server and checks all eight `tools/list` schemas, then validates the actual registered Zod objects without invoking tool handlers. Required fields, optional empty strings, enums, invalid types and unknown-field stripping are checked; network APIs are guarded and zero tool calls are made. Run `node tests/deploy/vision_stdio_probe.mjs /absolute/project /absolute/evidence.json` against an installed dependency tree. It uses an isolated temporary home and a visibly fake credential, never personal configuration. Zod 4's input-mode JSON Schema omits the prior `additionalProperties: false`; actual registered object parsing still strips unrecognized fields. Unused root `@iarna/toml` and `zod` declarations were removed; vision retains Zod as a controlled transitive dependency.

Primary compatibility references checked on 2026-10-25:

- [Official Node 24.22.1 checksums](https://nodejs.org/dist/v24.22.1/SHASUMS256.txt)
- [pnpm 11.22.0 metadata](https://registry.npmjs.org/pnpm/11.22.0), [pnpm fetch](https://pnpm.io/11.x/cli/fetch), [disabling pnpm hooks](https://pnpm.io/11.x/pnpmfile)
- [Official Codex Linux x64 0.164.0 metadata](https://registry.npmjs.org/@openai/codex/0.164.0-linux-x64)
- [Official custom model catalogs](https://learn.chatgpt.com/docs/model-catalogs), [fixed-version ModelInfo schema](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/protocol/src/openai_models.rs)
- [Official Amazon Bedrock providers](https://learn.chatgpt.com/docs/amazon-bedrock), [ChatGPT sign-in through a gateway](https://learn.chatgpt.com/docs/enterprise/sign-in-with-chatgpt-through-a-gateway), [pinned provider schema](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/core/config.schema.json)
- [GLM Coding Plan supported tools and Responses endpoint](https://docs.bigmodel.cn/cn/coding-plan/tool/others)
- [GLM search MCP](https://docs.bigmodel.cn/cn/coding-plan/mcp/search-mcp-server), [reader MCP](https://docs.bigmodel.cn/cn/coding-plan/mcp/reader-mcp-server), [zread MCP](https://docs.bigmodel.cn/cn/coding-plan/mcp/zread-mcp-server), [vision MCP](https://docs.bigmodel.cn/cn/coding-plan/mcp/vision-mcp-server)
- [Caddy official release](https://github.com/caddyserver/caddy/releases/tag/v2.11.7), [command validation](https://caddyserver.com/docs/command-line)
- [OWASP password storage](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html) and [session management](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html).
- [Linux ptrace credential checks](https://www.man7.org/linux/man-pages/man2/ptrace.2.html), [process FD duplication checks](https://linuxman7.org/linux/man-pages/man2/pidfd_getfd.2.html), [kernel procfs visibility](https://www.kernel.org/doc/html/latest/filesystems/proc.html), [Node 24 signal-triggered inspector control](https://nodejs.org/download/release/v24.19.0/docs/api/cli.html#--disable-sigusr1)
