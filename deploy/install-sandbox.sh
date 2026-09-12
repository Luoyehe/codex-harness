#!/usr/bin/env bash
# Distribution bubblewrap + narrowly scoped AppArmor setup, followed by a
# no-inference read-only sandbox preflight as the actual service account.
# Required: RUN_USER, CODEX_HOME, CODEX_WORKSPACE, CODEX_BIN. Inherit the same
# validated runtime PATH that will be persisted in the service unit.
set -euo pipefail
umask 022

BWRAP="/usr/bin/bwrap"
USERNS_RESTRICTION="/proc/sys/kernel/apparmor_restrict_unprivileged_userns"
APPARMOR_PROFILE="/etc/apparmor.d/bwrap-userns-restrict"
APPARMOR_EXTRA="/usr/share/apparmor/extra-profiles/bwrap-userns-restrict"

log() { printf '[sandbox] %s\n' "$*"; }
die() { printf '[sandbox] ERROR: %s\n' "$*" >&2; exit 1; }

for name in RUN_USER CODEX_HOME CODEX_WORKSPACE CODEX_BIN; do
  [ -n "${!name:-}" ] || die "$name is required"
done
case "$RUN_USER" in ''|[-.]*|*[!A-Za-z0-9_.-]*) die "RUN_USER is not a safe account name" ;; esac
[ "$(uname -s)" = Linux ] || die "Linux is required for this sandbox preflight"
[ "$(id -u)" -eq 0 ] || die "Run this helper with sudo, retaining RUN_USER/CODEX_HOME/CODEX_WORKSPACE/CODEX_BIN and the service PATH"
SERVICE_UID="$(id -u "$RUN_USER")" || die "Unknown service account: $RUN_USER"
if [ "$SERVICE_UID" -eq 0 ]; then
  die "RUN_USER must be non-root; migrate the service account before running this preflight (ALLOW_ROOT_SERVICE no longer bypasses this requirement)"
fi
SERVICE_HOME="$(getent passwd "$RUN_USER" | cut -d: -f6)"
[ -n "$SERVICE_HOME" ] || die "Cannot determine the service account home"
for name in CODEX_HOME CODEX_WORKSPACE CODEX_BIN; do
  case "${!name}" in /*) ;; *) die "$name must be an absolute path" ;; esac
done
[ -d "$CODEX_HOME" ] || die "Create CODEX_HOME for $RUN_USER before calling this helper"
[ -d "$CODEX_WORKSPACE" ] || die "Create CODEX_WORKSPACE for $RUN_USER before calling this helper"
[ -x "$CODEX_BIN" ] || die "CODEX_BIN is not executable: $CODEX_BIN"

install_packages() {
  command -v apt-get >/dev/null 2>&1 || die "Install the distribution package(s) manually: $*; apt-get is unavailable"
  apt-get update || die "apt-get update failed; resolve package-manager errors and rerun"
  DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "$@" \
    || die "Distribution package installation failed: $*"
}

# Package ownership alone does not make an administrator-modified profile a
# distribution profile. dpkg verification must also report no change to this
# exact file. Changes to unrelated package files do not authorize replacement.
distribution_file() {
  local file="$1" wanted="$2" owner package verification result=0
  [ -f "$file" ] && [ ! -L "$file" ] || return 1
  owner="$(dpkg-query -S "$file" 2>/dev/null)" || return 1
  case "$owner" in *$'\n'*) return 1 ;; esac
  package="${owner%%: *}"
  [ "${package%%:*}" = "$wanted" ] || return 1
  verification="$(dpkg --verify "$package" 2>/dev/null)" || result=$?
  [ "$result" -le 1 ] || return 1
  if awk -v wanted="$file" '$NF == wanted { found=1 } END { exit !found }' <<< "$verification"; then return 1; fi
}

if [ ! -x "$BWRAP" ]; then
  log "Installing distribution bubblewrap"
  install_packages bubblewrap
fi
[ -x "$BWRAP" ] && distribution_file "$BWRAP" bubblewrap \
  || die "Expected an unmodified distribution $BWRAP; inspect: dpkg --verify bubblewrap"
SELECTED_BWRAP="$(command -v bwrap || true)"
[ -n "$SELECTED_BWRAP" ] && [ "$(readlink -f "$SELECTED_BWRAP")" = "$(readlink -f "$BWRAP")" ] \
  || die "Service PATH does not select distribution $BWRAP; remove a shadowing bwrap or add /usr/bin, then rerun"

if [ -e "$USERNS_RESTRICTION" ]; then
  [ -r "$USERNS_RESTRICTION" ] || die "Cannot read $USERNS_RESTRICTION"
  RESTRICTED="$(<"$USERNS_RESTRICTION")"
  case "$RESTRICTED" in 0|1) ;; *) die "Unrecognized user namespace restriction value; inspect $USERNS_RESTRICTION" ;; esac
  if [ "$RESTRICTED" = 1 ]; then
    PROFILE_TO_LOAD="$APPARMOR_PROFILE"
    if [ -e "$APPARMOR_PROFILE" ] || [ -L "$APPARMOR_PROFILE" ]; then
      if distribution_file "$APPARMOR_PROFILE" apparmor; then
        log "Using the distribution AppArmor profile already installed"
      elif distribution_file "$APPARMOR_EXTRA" apparmor-profiles && [ ! -L "$APPARMOR_PROFILE" ] && cmp -s "$APPARMOR_EXTRA" "$APPARMOR_PROFILE"; then
        log "Reusing the unchanged copy of the distribution AppArmor profile"
      else
        log "WARNING: existing custom/modified $APPARMOR_PROFILE preserved (not loaded or overwritten); checking the administrator's currently loaded policy via the mandatory non-root preflight"
        PROFILE_TO_LOAD=""
      fi
    else
      if ! distribution_file "$APPARMOR_EXTRA" apparmor-profiles; then
        install_packages apparmor-profiles
      fi
      distribution_file "$APPARMOR_EXTRA" apparmor-profiles \
        || die "Distribution bwrap-userns-restrict profile unavailable/modified. Inspect: dpkg -L apparmor-profiles; dpkg --verify apparmor-profiles"
      command -v apparmor_parser >/dev/null 2>&1 \
        || die "apparmor_parser is missing; install the distribution apparmor package and rerun"
      install -d -m 0755 "$(dirname "$APPARMOR_PROFILE")"
      install -m 0644 "$APPARMOR_EXTRA" "$APPARMOR_PROFILE"
    fi
    if [ -n "$PROFILE_TO_LOAD" ]; then
      command -v apparmor_parser >/dev/null 2>&1 \
        || die "apparmor_parser is missing; install the distribution apparmor package and rerun"
      apparmor_parser -r "$PROFILE_TO_LOAD" \
        || die "Dedicated AppArmor profile failed to load. Inspect: apparmor_parser -r $PROFILE_TO_LOAD; journalctl -k --since '-5 min' --no-pager"
      log "Loaded only bwrap-userns-restrict; global user namespace restrictions are unchanged"
    fi
  fi
fi

log "Running read-only sandbox /usr/bin/true as $RUN_USER in $CODEX_WORKSPACE (no inference)"
# SSH/runuser may inherit /root. Change directory before dropping privileges,
# then check accessibility again as the target user. Start with an empty child
# environment: installation-time provider credentials are not needed here.
# The pinned 0.149 CLI uses `sandbox --`, not a `sandbox linux` subcommand.
if ! (
  cd -- "$CODEX_WORKSPACE" || exit 1
  runuser -u "$RUN_USER" -- env -i HOME="$SERVICE_HOME" CODEX_HOME="$CODEX_HOME" PATH="$PATH" \
    /bin/sh -c 'cd -- "$1" && shift && exec "$@"' \
    sandbox-preflight "$CODEX_WORKSPACE" "$CODEX_BIN" sandbox -c 'sandbox_mode="read-only"' -- /usr/bin/true
); then
  printf '[sandbox] Reproduce without inference:\n  cd -- %q && runuser -u %q -- env -i HOME=%q CODEX_HOME=%q PATH=%q %q sandbox -c %q -- /usr/bin/true\n' \
    "$CODEX_WORKSPACE" "$RUN_USER" "$SERVICE_HOME" "$CODEX_HOME" "$PATH" "$CODEX_BIN" 'sandbox_mode="read-only"' >&2
  die "Read-only sandbox preflight failed; inspect directory permissions and journalctl -k --since '-5 min' --no-pager. The installer will not disable sandboxing or relax global security settings"
fi
log "SANDBOX-PREFLIGHT-PASS (non-root, explicit read-only policy, /usr/bin/true completed)"
