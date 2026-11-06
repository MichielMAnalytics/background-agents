#!/usr/bin/env bash
# Open-Inspect runtime launcher for boxd sandboxes.
#
# Baked into the base snapshot at /home/boxd/openinspect/launcher.sh. The
# control plane starts it, detached, once a new session machine is up and its
# session env file is written, and again after every resume. A resume wakes a
# hibernated machine with its memory intact, so the runtime is usually still
# running, which step 2 detects. After a cold start (a stopped
# machine) only the disk is left, and step 4 boots the runtime in restored
# mode. It runs as `boxd`; nothing of the session rides its command line.
#
# In order, it
#   1. recreates what a cold boot does not carry (/tmp/opencode, the SCM
#      credential cache) and waits for the toolchain under /opt/openinspect;
#   2. takes the single-instance lock, exiting EXIT_ALREADY_RUNNING when a
#      runtime already holds it. The lock is held by the runtime process
#      itself (the descriptor survives the exec below), so a woken machine
#      whose runtime is alive refuses a second one;
#   3. sources the session env the control plane wrote (mode 0600:
#      CONTROL_PLANE_URL, SESSION_CONFIG, the sandbox auth token, user
#      secrets) and points the runtime's cross-boot state
#      (OPENINSPECT_STATE_DIR) at the home directory;
#   4. decides the boot mode from the completed-boot marker: the runtime
#      creates it (OI_BOOT_COMPLETE_MARKER) once a boot has synced the
#      checkout, run setup.sh and started the harness. A later boot that finds
#      it exports RESTORED_FROM_SNAPSHOT=true, so the runtime keeps its
#      checkout and skips setup.sh; a boot interrupted before then leaves no
#      marker and the next start boots fresh again;
#   5. execs the runtime entrypoint with its output in the supervisor log.
#
# `--prepare-only` performs step 1 and exits; the image build uses it to
# verify a fresh restore without starting a session runtime.
set -euo pipefail

OI_USER_HOME=/home/boxd
OI_STATE_DIR=$OI_USER_HOME/.openinspect
OI_LOCK_FILE=/tmp/openinspect-runtime.lock
# Mirrors BOXD_SESSION_ENV_FILE_PATH in the control plane (boxd-provider.ts).
OI_SESSION_ENV_FILE=$OI_STATE_DIR/session.env
OI_BOOT_COMPLETE_MARKER=$OI_STATE_DIR/boot-complete
OI_RUNTIME_STATE_DIR=$OI_STATE_DIR/state
OI_SUPERVISOR_LOG=$OI_STATE_DIR/supervisor.log
OI_PYTHON=/opt/openinspect/python/bin/python
OI_RUNTIME_ENVIRONMENT=/app/openinspect-runtime-environment.json
OI_TOOLCHAIN_WAIT_SECONDS=${OI_TOOLCHAIN_WAIT_SECONDS:-120}
EXIT_ALREADY_RUNNING=75

log() { printf 'openinspect-launcher: %s\n' "$*" >&2; }

prepare() {
  mkdir -p "$OI_STATE_DIR" "$OI_RUNTIME_STATE_DIR" "$OI_USER_HOME/.cache/openinspect/scm" \
    /tmp/opencode
  local waited=0
  until [[ -x "$OI_PYTHON" && -f "$OI_RUNTIME_ENVIRONMENT" && -d /workspace ]]; do
    if (( waited >= OI_TOOLCHAIN_WAIT_SECONDS )); then
      log "runtime toolchain missing after ${OI_TOOLCHAIN_WAIT_SECONDS}s ($OI_PYTHON, $OI_RUNTIME_ENVIRONMENT, /workspace)"
      exit 1
    fi
    sleep 1
    waited=$((waited + 1))
  done
}

# load_session_env: the session cannot boot without its env (no control plane
# to call, no auth token), so a missing file ends the launch here, where the
# control plane's settle window sees the exit.
load_session_env() {
  if [[ ! -f "$OI_SESSION_ENV_FILE" ]]; then
    log "session env file missing: $OI_SESSION_ENV_FILE"
    exit 1
  fi
  # shellcheck disable=SC1090
  . "$OI_SESSION_ENV_FILE"
}

main() {
  if [[ "${1:-}" == "--prepare-only" ]]; then
    prepare
    log "prepared"
    exit 0
  fi
  if (( $# )); then
    log "unknown argument: $1"
    exit 2
  fi
  prepare
  exec 9>"$OI_LOCK_FILE"
  if ! flock -n 9; then
    log "runtime already running"
    exit "$EXIT_ALREADY_RUNNING"
  fi
  load_session_env
  export OI_BOOT_COMPLETE_MARKER
  export OPENINSPECT_STATE_DIR="$OI_RUNTIME_STATE_DIR"
  if [[ -e "$OI_BOOT_COMPLETE_MARKER" ]]; then
    export RESTORED_FROM_SNAPSHOT=true
    log "an earlier boot completed; starting the runtime in restored mode"
  else
    log "no completed boot on this disk; starting the runtime fresh"
  fi
  if [[ -f "$OI_SUPERVISOR_LOG" ]]; then
    mv -f "$OI_SUPERVISOR_LOG" "$OI_SUPERVISOR_LOG.1"
  fi
  cd /workspace
  exec "$OI_PYTHON" -m sandbox_runtime.entrypoint >>"$OI_SUPERVISOR_LOG" 2>&1
}

main "$@"
