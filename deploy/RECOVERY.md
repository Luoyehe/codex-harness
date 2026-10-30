# Recovery and maintenance

Run operator commands from the reviewed deployment checkout. Keep the original instance name, numeric service identities and protected configuration. There is no general `backup` or `restore` CLI command. Completed build workspaces have a dedicated, non-destructive `candidate-archive` command.

## Choose the recovery operation

| Retained state | Operation |
| --- | --- |
| New initialization journal exists, initialization or first installation is incomplete | `install-resume --source /absolute/harness-source.tgz` |
| Initialization completed; build or first application startup failed | `update --source /absolute/harness-source.tgz` |
| Application/provider/HTTPS transaction interrupted | Inspect the error, then `repair`; application-only forward recovery supports `repair --target candidate` |
| Trusted control update interrupted | `control-recover` from the separate reviewed checkout |
| Execution identity or root-authorization transaction interrupted | `execution-mode-recover --target old` (default) or explicitly `--target candidate`; `repair` routes this same retained transaction |
| Service proxy transaction interrupted | `proxy-recover --target old` (default) or explicitly `--target candidate`; retain both core/configuration generations |
| Services removed by a recorded new-version `uninstall` | `restore-services` |

For example:

```sh
sudo python3 -B -m deploy.cli --instance demo install-resume --source /tmp/harness-source.tgz
# Separately, after an intentional recorded uninstall:
sudo python3 -B -m deploy.cli --instance demo restore-services
```

`install-resume` uses `/etc/codex-harness/.demo-initialize.json` to bind the original configuration, reserved UID/GID values and credential fingerprints. It accepts no new origin, username or password. Use the same reviewed deployment-code generation; changing code requires returning to the recorded source, not deleting its journal. An unknown legacy directory is not resumable ownership evidence.

If initialization names a shared service directory with insufficient traversal permissions, inspect that exact path before retrying. A restrictive `umask` and interruption between directory creation and permission setup can leave a root-owned `0700` shared container. The installer preserves existing directory permissions and stops before creating service identities or starting services. An operator may correct only the diagnosed, verified root-owned shared container (normally `/etc/codex-harness`, `/opt/codex-harness`, `/var/lib/codex-harness-instances` or `/usr/lib/codex-harness`) to its intended traversable mode, usually `0755`, then use `install-resume` if the initialization journal exists; otherwise repeat the original install command. Do not recursively chmod, change private instance directories, adopt unknown ownership, or delete journals to bypass this check.

`restore-services` restores the saved unit/sudo definitions and original running/enabled sets while preserving the account, provider settings and data. It requires the protected snapshot created by the new uninstall workflow. An older `uninstalled.json` containing only `servicesRemoved` is insufficient. If restoration remains unconfirmed, retain the barriers/journal and retry `restore-services`; `repair` does not replace this operation. Never reinstall the same instance to reconstruct missing evidence.

Execution-mode recovery restores the recorded configuration, native identity, worker unit and sudo policy only after confirming service shutdown. It retains both `worker/codex` and the independent `worker-root/codex`; it never recursively changes ownership or copies credentials/history between them. A failed restore leaves its pending transaction and start barriers for explicit recovery. Recovery of an authorization change while root is disabled requires an independent administrator SSH/console, just like the original authorization. Revoking an active root policy returns to native in the same transaction or fails without presenting root as disabled. This does not undo earlier host-root actions, restore changed system files or make root-owned project files accessible to the native UID.

## Consistent offline backup

This procedure is for a completely initialized instance with no unfinished management transaction. Complete or explicitly recover pending work first. It deliberately uses the recorded `uninstall` / `restore-services` workflow for a maintenance outage: uninstall saves the original units, sudo policy and running/enabled sets, installs persistent start barriers, then removes only service definitions. It does **not** delete the account or application data. Those durable barriers and removed definitions prevent a reboot from starting a half-copied database. A live SQLite-file copy alone is not a backup; include every database with its WAL/SHM files and associated credentials from the same stopped window.

Before taking locks, run the new recorded uninstall and require `servicesRemoved: true`:

```sh
sudo python3 -B -m deploy.cli --instance demo uninstall
```

The backup will contain the resulting `removed` lifecycle journal and barriers. An older unrecorded uninstall cannot provide this maintenance workflow.

The complete instance snapshot covers:

| Path for instance `demo` | Contents |
| --- | --- |
| `/opt/codex-harness/demo` | Immutable releases and both selection pointers |
| `/opt/codex-harness-proxy/demo` when present | Selected and retained immutable Xray core generations; required when the snapshot has a proxy selection, even if disabled |
| `/etc/codex-harness/demo` | Configuration, manifests, account bootstrap, token, provider generations, TLS/CA generations and recovery barriers |
| `/etc/codex-harness/.demo-initialize.json` when present | Original initialization ownership journal |
| `/var/lib/codex-harness-instances/demo` | Gateway databases, separate native/root homes, supervisor state, receipts, transactions, Caddy certificates/ACME account and retained identity material |
| `/usr/lib/codex-harness/demo` and `.demo-control-transactions` beside it | Exact trusted control generation, edge binaries and completed control recovery generations |
| `/var/cache/codex-harness/demo` | Toolchain and retained build/recovery workspaces, including sparse images |
| Exact `codex-harness-demo-{gateway,worker,caddy,authelia,config-check,proxy,proxy-routes}.service.d` directories when present | Only this instance's persistent start barriers, including retained proxy barriers; service files and enablement links are removed during the window |
| Bound service-lifecycle journal inside the instance state directory | Saved unit/sudo contents and original active/enabled sets used by `restore-services` |

Project directories outside these roots need a separate filesystem snapshot during the same stopped window. Record those paths explicitly. `/run/codex-harness-demo` is ephemeral and is not restored. Record, but do not overwrite, shared `/etc/codex/{config,requirements,managed_config}.toml`; other instances may use them. Preserve service UID/GID mappings; this is a same-machine restore procedure, not a cross-host migration.

Start a root shell, substitute the instance in the three fixed lock paths, and keep this shell open through backup or restore. All ordinary management **and control updates share `management.lock`**; initialization has the adjacent lock. Do not invoke a CLI mutation from inside this locked shell.

```sh
sudo -i
set -euo pipefail
umask 077
cd /root/reviewed-harness
export INSTANCE=demo
export BACKUP=/root/harness-backups/demo-$(date -u +%Y%m%dT%H%M%SZ)
install -d -m 700 "$BACKUP"
exec 8<>/etc/codex-harness/.demo-initialize.lock
flock -n 8
exec 9<>/etc/codex-harness/demo/management.lock
flock -n 9
```

The following verifies the recorded removal, repeats the stop/cgroup checks and twice enumerates only exact instance services/transients. A remaining process, mount or unknown state aborts; do not bypass that failure. The lifecycle journal is the one permitted pending transaction during this window.

```sh
python3 -B - <<'PY'
import hashlib, json, os
from pathlib import Path
from deploy.common import Layout, digest, require
from deploy.control_update import ControlSystem
from deploy.manager import Manager
from deploy.ownership import ROLES, present
from deploy.service_lifecycle import identity_state, read_record, require_only_transaction, service_paths, verify_retained
from deploy.service_proxy import PROXY_ROLES
from deploy.safe_fs import inspect_tree

layout = Layout(os.environ['INSTANCE'])
output = Path(os.environ['BACKUP'])
system = ControlSystem()
manager = Manager(layout, system)
journal, lifecycle = read_record(layout)
require(lifecycle['phase'] == 'removed', 'Complete recorded uninstall before backup')
require_only_transaction(layout, journal)
verify_retained(manager, lifecycle)
require(all(not present(path) for path in service_paths(layout, manager.config).values()), 'A removed service definition reappeared')
installation = manager.initial_installation(persist=False)
require(manager.selected() is not None and (installation is None or installation['phase'] == 'complete'),
        'Finish first installation before this backup procedure')
services = {'active': lifecycle['active'], 'enabled': lifecycle['enabled']}
roles = (*ROLES, *PROXY_ROLES)
fixed = [layout.unit(role) for role in roles]
system.stop(list(dict.fromkeys(fixed + system.instance_units(layout))))
system.stop(list(dict.fromkeys(fixed + system.instance_units(layout))))
system.no_instance_processes(layout, manager.config)
roots = [layout.app, layout.config, layout.state, layout.control, layout.work,
         layout.root / 'opt/codex-harness-proxy' / layout.instance,
         layout.control.parent / ('.' + layout.instance + '-control-transactions')]
for line in Path('/proc/self/mountinfo').read_text().splitlines():
    mounted = Path(line.split()[4])
    require(not any(mounted == root or mounted.is_relative_to(root) for root in roots),
            'Retained instance mount requires inspection before backup')
paths = [path for path in roots if present(path)]
paths += [path for path in [layout.config.parent / ('.' + layout.instance + '-initialize.json'),
          Path('/etc/sudoers.d') / ('codex-harness-' + layout.instance)] if present(path)]
for role in roles:
    unit = layout.unit(role)
    paths += [path for path in (layout.units / unit, layout.units / (unit + '.d')) if present(path)]
    for suffix in ('wants', 'requires'):
        paths += list(layout.units.glob('*.' + suffix + '/' + unit))
relative = sorted({str(path.relative_to('/')) for path in paths})
host = {name: hashlib.sha256(Path('/etc/codex', name).read_bytes()).hexdigest()
        if Path('/etc/codex', name).exists() else None
        for name in ('config.toml', 'requirements.toml', 'managed_config.toml')}
record = {'instance': layout.instance, 'paths': relative, 'services': services,
          'identities': identity_state(layout), 'hostPolicy': host,
          'controlDigest': digest(inspect_tree(layout.control, root_owned=True))}
(output / 'snapshot.json').write_text(json.dumps(record, indent=2) + '\n')
(output / 'paths.nul').write_bytes(b''.join(path.encode() + b'\0' for path in relative))
PY
tar --create --file "$BACKUP/instance.tar" --directory / \
  --numeric-owner --acls --xattrs --sparse --null --verbatim-files-from \
  --files-from "$BACKUP/paths.nul"
(cd "$BACKUP" && sha256sum instance.tar snapshot.json paths.nul > SHA256SUMS)
sync
```

Keep the archive and its checksums in private, preferably encrypted storage. It contains credentials, certificate private keys, sessions and sensitive receipts. Do not place it in the repository. The copy leaves services removed, persistent barriers in place and locks held. If a command fails, keep that state and inspect the error. After a successful backup, end the window by releasing both locks and explicitly restoring the recorded services:

```sh
flock -u 9
flock -u 8
python3 -B -m deploy.cli --instance demo restore-services
python3 -B -m deploy.cli --instance demo status
```

## Restore on the same machine

Use only a trusted snapshot produced above. Keep the same instance name, paths, accounts, numeric UID/GID values and reviewed control code. Do not restore onto a newly initialized same-name instance or over an unrelated unit. Restoring old authentication databases may reinstate credentials or sessions that were changed or revoked after the snapshot; review restored account access after login.

1. Run the new `uninstall` against the current intact instance first and require its recorded `removed` state. This protects the restore window across reboot. Then acquire the two locks above, pointing `BACKUP` at the chosen existing snapshot; do **not** create a new backup directory over it. Repeat the stop/cgroup/process checks without overwriting snapshot metadata. If the existing instance cannot pass recorded uninstall/ownership checks, stop for operator recovery rather than copying over an unclaimed directory.
2. Verify checksums and extract into a new private staging directory. Never extract directly over `/` or the whole `/etc/systemd/system` directory.

   ```sh
   (cd "$BACKUP" && sha256sum -c SHA256SUMS)
   export STAGE=$(mktemp -d /root/harness-restore.XXXXXXXX)
   tar --extract --file "$BACKUP/instance.tar" --directory "$STAGE" \
     --numeric-owner --same-owner --same-permissions --acls --xattrs --sparse
   ```

3. Compare `snapshot.json` identities with `identity_state(Layout(INSTANCE))` and the three host-policy fingerprints with the current host. Stop on differences; do not recreate accounts, `chown -R`, or overwrite shared host policy to force a match. Check that the archive's top-level instance paths and exact unit/link paths match its saved `paths` list.
4. Preserve the current directories in adjacent, timestamped quarantine directories before installing the corresponding staged directories. Use same-filesystem renames and retain that quarantine until acceptance. For `/etc/codex-harness/INSTANCE`, preserve the **directory and its existing `management.lock` inode**: move each other child into a private adjacent quarantine directory and copy each staged child back with `cp -a`, excluding staged `management.lock`. Replacing that lock or its parent would let another process acquire a different inode while this shell still appears locked. Keep the adjacent initialization lock too.
5. Restore only the instance's saved drop-in/barrier directories and recorded state. Unit files, sudo policy and enablement links remain absent; their original contents are inside the lifecycle journal. Quarantine current entries for the exact seven unit names listed above, including proxy entries or links absent from an older snapshot. Never copy a complete `.wants` directory or another instance's files. Preserve numeric ownership, modes, ACLs and symlinks. Do not restore runtime sockets, PIDs or transient units.
6. Validate the restored `removed` lifecycle record with `verify_retained`, which checks the recorded configuration/control/identity/release bindings while allowing absent managed definitions. Do not invoke `systemctl start` or recreate unit files by hand.
7. Leave services removed on any failure. After a clean inspection, release descriptors 9 and 8, then run `restore-services`. It restores the snapshot's exact original running/enabled sets through the checked lifecycle transaction. Confirm its result and run `status`. Run full `verify` when gateway and Caddy are intended to be running, then test public HTTPS from an external client. A deliberately stopped edge should remain stopped.

The following performs steps 3–6 on the already stopped, locked instance. `STAGE` must be the new extraction directory from step 2. Before the first move it prints and durably writes `restore-progress-ID.json` in the backup directory. Each rename/copy destination is recorded before the action and marked complete afterward; replaced paths remain beside their originals. There is no recursive deletion or automatic startup.

A snapshot with a configured proxy must include its core directory and both proxy barrier directories; its selected core and configuration are verified in staging before any move. Older snapshots without a proxy selection need no proxy files. When restoring such a snapshot, any current proxy core directory and exact proxy service entries are quarantined with the other replaced materials, not deleted or adopted by the old configuration.

```sh
python3 -B - <<'PY'
import hashlib, json, os, re, subprocess, uuid
from pathlib import Path
from deploy.common import Layout, digest, fsync_directory, read_json, require, write_json
from deploy.control_update import ControlSystem
from deploy.manager import Manager
from deploy.ownership import ROLES, present
from deploy.safe_fs import inspect_tree
from deploy.service_lifecycle import identity_state, read_record, require_only_transaction, service_paths, verify_retained
from deploy.service_proxy import PROXY_ROLES, selection, verify_selection

layout = Layout(os.environ['INSTANCE'])
backup, stage = Path(os.environ['BACKUP']), Path(os.environ['STAGE'])
saved = json.loads((backup / 'snapshot.json').read_text())
require(saved['instance'] == layout.instance and saved['identities'] == identity_state(layout),
        'Snapshot instance or numeric identities differ')
for name, expected in saved['hostPolicy'].items():
    require(name in ('config.toml', 'requirements.toml', 'managed_config.toml'), 'Unknown host-policy name')
    path = Path('/etc/codex') / name
    actual = hashlib.sha256(path.read_bytes()).hexdigest() if path.exists() else None
    require(actual == expected, 'Shared host policy changed; inspect separately')
require(os.fstat(9).st_ino == (layout.config / 'management.lock').stat().st_ino and
        os.fstat(9).st_dev == (layout.config / 'management.lock').stat().st_dev,
        'Maintenance lock no longer names the held inode')
manager = Manager(layout, ControlSystem())
journal, current = read_record(layout)
require(current['phase'] == 'removed', 'Complete recorded uninstall before restoration')
require_only_transaction(layout, journal)
verify_retained(manager, current)
require(all(not present(path) for path in service_paths(layout, manager.config).values()), 'A removed service definition reappeared')
manager.system.no_instance_processes(layout, manager.config)
staged_layout = Layout(layout.instance, stage)
staged_config = read_json(staged_layout.config / 'instance.json')
staged_proxy = selection(staged_config)
verify_selection(staged_layout, staged_config)
proxy_root = layout.root / 'opt/codex-harness-proxy' / layout.instance
roots = [layout.app, layout.config, layout.state, layout.control, layout.work,
         proxy_root,
         layout.control.parent / ('.' + layout.instance + '-control-transactions'),
         layout.config.parent / ('.' + layout.instance + '-initialize.json'),
         Path('/etc/sudoers.d') / ('codex-harness-' + layout.instance)]
units = [layout.unit(role) for role in (*ROLES, *PROXY_ROLES)]
for unit in units:
    roots += [layout.units / unit, layout.units / (unit + '.d')]
allowed = {str(path.relative_to('/')) for path in roots}
link_pattern = r'etc/systemd/system/[A-Za-z0-9_.@:-]+\.(?:wants|requires)/(?:' + '|'.join(map(re.escape, units)) + ')'
require(len(saved['paths']) == len(set(saved['paths'])) and
        all(path in allowed or re.fullmatch(link_pattern, path) for path in saved['paths']),
        'Snapshot contains a path outside this instance')
required = {str(path.relative_to('/')) for path in (layout.app, layout.config, layout.state, layout.control, layout.work)}
if staged_proxy is not None:
    required.add(str(proxy_root.relative_to('/')))
    required.update(str((layout.units / (layout.unit(role) + '.d')).relative_to('/')) for role in PROXY_ROLES)
require(required <= set(saved['paths']), 'Snapshot omits a required instance root')
for path in saved['paths']:
    require(present(stage / path), 'Staged snapshot path is missing')
targets = set(roots) | {Path('/') / path for path in saved['paths']}
for unit in units:
    for suffix in ('wants', 'requires'):
        targets.update(layout.units.glob('*.' + suffix + '/' + unit))
tag = uuid.uuid4().hex
quarantined = []
checkpoint = backup / ('restore-progress-' + tag + '.json')
progress = {'instance': layout.instance, 'stage': str(stage), 'phase': 'prepared',
            'originalRemoval': str(journal), 'lockDevice': os.fstat(9).st_dev,
            'lockInode': os.fstat(9).st_ino, 'operations': []}
write_json(checkpoint, progress)
print('Restore checkpoint: ' + str(checkpoint), flush=True)
def action(kind, source, target):
    entry = {'kind': kind, 'source': str(source), 'target': str(target), 'state': 'planned'}
    progress['operations'].append(entry)
    progress['phase'] = 'copying'
    write_json(checkpoint, progress)
    if kind == 'rename':
        os.rename(source, target)
        fsync_directory(source.parent)
    else:
        subprocess.run(['cp', '-a', '--', str(source), str(target)], check=True)
        subprocess.run(['sync', '-f', str(target)], check=True)
    fsync_directory(target.parent)
    entry['state'] = 'completed'
    write_json(checkpoint, progress)
def retain(path):
    target = path.with_name('.' + path.name + '.before-restore-' + tag)
    require(not present(target), 'Quarantine collision')
    action('rename', path, target)
    quarantined.append(str(target))
for target in sorted(targets, key=str):
    incoming = stage / target.relative_to('/')
    if target == layout.config:
        quarantine = target.with_name('.' + target.name + '.before-restore-' + tag)
        quarantine.mkdir(mode=0o700)
        fsync_directory(quarantine.parent)
        quarantined.append(str(quarantine))
        for child in sorted(target.iterdir()):
            if child.name != 'management.lock': action('rename', child, quarantine / child.name)
        for child in sorted(incoming.iterdir()):
            if child.name != 'management.lock':
                action('copy', child, target / child.name)
    else:
        if present(target): retain(target)
        if str(target.relative_to('/')) in saved['paths']:
            target.parent.mkdir(parents=True, exist_ok=True)
            action('copy', incoming, target)
manager = Manager(layout, ControlSystem())
journal, restored = read_record(layout)
require(restored['phase'] == 'removed', 'Snapshot was not taken during recorded removal')
require_only_transaction(layout, journal)
verify_retained(manager, restored)
require(all(not present(path) for path in service_paths(layout, manager.config).values()), 'Snapshot unexpectedly contains service definitions')
require(digest(inspect_tree(layout.control, root_owned=True)) == saved['controlDigest'], 'Restored control tree differs')
progress['phase'] = 'verified'
progress['quarantined'] = quarantined
write_json(checkpoint, progress)
print('Restored bindings verified; services remain removed. Run restore-services after unlocking.')
PY
```

If interrupted, preserve the checkpoint, staging directory, archive and every quarantine path. The lifecycle marker or its journal may temporarily be in quarantine, so `restore-services` may correctly refuse and rerunning the whole copy block may not be safe. Under the same locks, inspect each recorded source/target: a `planned` action may have taken effect before its completion record was written. Use those exact paths to finish the validated snapshot replacement or reverse the completed moves; do not guess from a missing marker or replace a partially restored directory with a fresh installation. Only after the stopped binding checks pass and the checkpoint reaches `verified` should service restoration proceed. Removed unit files keep partial copies from starting at boot.

After the stopped checks succeeded:

```sh
flock -u 9
flock -u 8
python3 -B -m deploy.cli --instance demo restore-services
python3 -B -m deploy.cli --instance demo status
```

The snapshot is a recovery input, not proof that a restore has been rehearsed. Retain both the archive and quarantined state until the restored application, account login, TLS and project data have been checked.

## Archive completed build candidates

At eight retained `candidate-*` directories, another build is refused. `provider-prune` manages provider generations only. It does not remove build candidates, releases, control journals or TLS generations.

Use `sh harness.sh` → **修复 / 恢复 / 回滚** → **归档已完成构建**. The menu lists verified candidates, asks which exact candidate to archive, and confirms a brief service interruption. It then performs the recorded maintenance, two-lock checks, same-filesystem move and service restoration below. It never deletes a workspace, release or receipt. If runtime activity is unknown, first use recovery/restart to establish its state. For automation:

```sh
python3 -B -m deploy.cli --instance demo candidate-list
python3 -B -m deploy.cli --instance demo candidate-archive --candidate VERIFIED_32_HEX_ID --confirm-stop
```

The private archive and progress inventory are under `/var/cache/codex-harness/operator-archives/INSTANCE`. On interruption, keep both paths and all original transaction records. Retry the same candidate to finish an already recorded move or service restoration; the menu also lists unfinished archives. If service removal stopped before the archive could bind its lifecycle record, run `restore-services` first and retry. Do not manually remove the journal or overwrite an existing destination. Moving caches frees an upgrade slot, not disk space.

The following manual procedure describes the same safeguards and remains available for inspection:

Use the same recorded `uninstall`, two locks and stopped-instance checks above. Inspect one exact 32-hex candidate ID. Require all of the following before moving it:

- `/var/lib/codex-harness-instances/INSTANCE/transactions/ID/prepared.json` exists, names a release whose full manifest verifies, and records all three successful native initialization, offline boundary and sandbox probes.
- The only pending transaction is the current verified `removed` service-lifecycle record. No unfinished release/provider/configuration-layer/HTTPS/control transaction remains. A preparation record alone does not establish that a failed or interrupted activation is safe to discard.
- All exact `fetch/install/tsc/web/gateway-check/worker-check/runtime-probe/sandbox-ID` transient units are stopped with empty cgroups; no instance UID/helper process remains.
- Neither the candidate nor any descendant is a mount point, and neither `fetch.ext4` nor `build.ext4` remains. A `prepared.json` can be written **before** final unmount/image cleanup; its presence alone is insufficient.

Archive by moving the entire confirmed candidate to a private directory on the **same filesystem**, outside `/var/cache/codex-harness/INSTANCE/candidate-*`. For example, after verifying the exact ID and destination:

```sh
install -d -m 700 /var/cache/codex-harness/operator-archives/demo
mv -T -- /var/cache/codex-harness/demo/candidate-VERIFIED_32_HEX_ID \
  /var/cache/codex-harness/operator-archives/demo/candidate-VERIFIED_32_HEX_ID
```

Require an absent destination and equal filesystem device IDs before `mv`; never merge or overwrite an archive. Record the ID, release and checks performed in the archive inventory. Keep its transaction records in their original location. Release both locks and use `restore-services` to end the window. Moving a candidate frees a retention slot, **not disk space**. Failed, unprepared, mounted, active or ambiguous candidates remain untouched for inspection. Do not use wildcard deletion or treat application `rollback` as a candidate-cleanup command.

DNS component preparation has a separate eight-directory retention limit under `dns-build-ID`. It can retain `work.ext4` and a mounted `work` directory after a failure. Inspect the exact `dns-fetch/verify/test/build/probe-ID` transient units and their cgroups before handling that workspace. A successful component build does not prove certificate issuance. Do not apply the candidate archive command to DNS workspaces or remove a mounted image. Selected binary generations under `control/edge/caddy/dns` and credential generations under `config/dns` are recovery material; retain them with the instance backup. In particular, an old RAM key may need to remain valid until an interrupted rotation has been resolved.

## Service proxy recovery

Use the same trusted control generation and retain the private transaction journal, selected VLESS configuration and both core generations. `proxy-recover --target old` restores the recorded selection and activity; `--target candidate` explicitly completes the interrupted candidate. `repair --target old|candidate` also routes a sole pending service-proxy transaction through this recovery. Neither command retries an unrelated request or deletes a journal to bypass a guard.

Recovery validates retained configuration/core hashes and exact unit definitions, confirms the main service cgroups stopped, then stops the proxy pair before publishing rules and selection. It changes only the owned chains while preserving the PID1-managed membership set; removal requires empty membership. The proxy and routing units are static dependencies with no separately modified enablement state. Unknown shutdown or failed restoration leaves barriers and a pending journal. Keep both old and candidate materials until recovery is verified.

A normal `proxy-rollback --confirm-restart` uses the previous completed selection bound to the current proxy configuration; it does not roll back accounts, application data or root execution policy. Disabling retains proxy configuration and cores. Retained proxy selections require a control generation declaring proxy support, including when disabled. The fixed `proxy-core-check`, `proxy-routes-start` and `proxy-ready` launcher helpers can run during control restoration only from their exact root systemd service contexts; management RPC and execute requests remain blocked by unfinished control maintenance.
