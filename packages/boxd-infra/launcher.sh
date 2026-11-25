#!/usr/bin/env bash
# Open-Inspect runtime launcher for boxd machines; see README.md.
#
#   launcher.sh accept  the control plane runs this through sudo right after it
#                       wrote the session environment into the inbox: the file
#                       moves to /etc/openinspect/session.json (root only) and
#                       the service starts. On a machine whose runtime is
#                       already running (a resume of a hibernated machine) the
#                       start changes nothing.
#   launcher.sh run     openinspect-sandbox.service runs this on every start,
#                       including the boot after a stopped machine is started
#                       again: it starts the runtime as `user`, in restored mode
#                       when an earlier boot on this disk completed.
set -Eeuo pipefail

OI_ETC=/etc/openinspect
OI_SESSION_ENV_FILE=$OI_ETC/session.json
# Mirror BOXD_SESSION_INBOX_PATH and BOXD_TUNNEL_INBOX_PATH in the control
# plane (boxd-provider.ts).
OI_INBOX_FILE=/home/boxd/.openinspect/session.json
OI_TUNNEL_INBOX_FILE=/home/boxd/.openinspect/tunnels.env
# Mirrors TUNNEL_ENV_FILE_PATH in sandbox_runtime/constants.py.
OI_TUNNEL_ENV_FILE=/workspace/.tunnels.env
OI_RUNTIME_USER=user
OI_STATE_DIR=/home/$OI_RUNTIME_USER/.openinspect
OI_BOOT_COMPLETE_MARKER=$OI_STATE_DIR/boot-complete
OI_PYTHON=/opt/openinspect/python/bin/python
OI_EXEC_RUNTIME=/opt/openinspect/boxd/exec-runtime.py
OI_SERVICE=openinspect-sandbox.service

log() { printf 'openinspect-launcher: %s\n' "$*" >&2; }

accept() {
  install -d -m 0700 "$OI_ETC"
  if [[ -f "$OI_INBOX_FILE" ]]; then
    if ! "$OI_PYTHON" "$OI_EXEC_RUNTIME" --check "$OI_INBOX_FILE"; then
      rm -f "$OI_INBOX_FILE"
      log "the session environment in the inbox is not valid"
      exit 1
    fi
    install -m 0600 -o root -g root "$OI_INBOX_FILE" "$OI_SESSION_ENV_FILE"
    rm -f "$OI_INBOX_FILE"
    log "session environment received"
  fi
  if [[ -f "$OI_TUNNEL_INBOX_FILE" ]]; then
    install -m 0644 -o "$OI_RUNTIME_USER" -g "$OI_RUNTIME_USER" "$OI_TUNNEL_INBOX_FILE" "$OI_TUNNEL_ENV_FILE"
    rm -f "$OI_TUNNEL_INBOX_FILE"
  fi
  if [[ ! -f "$OI_SESSION_ENV_FILE" ]]; then
    log "no session environment; nothing to start"
    exit 1
  fi
  systemctl start --no-block "$OI_SERVICE"
}

run() {
  local is_restored=false
  if [[ -e "$OI_BOOT_COMPLETE_MARKER" ]]; then
    is_restored=true
  fi
  log "starting the runtime (restored: $is_restored)"
  exec "$OI_PYTHON" "$OI_EXEC_RUNTIME" --run "$OI_SESSION_ENV_FILE" --restored "$is_restored"
}

case "${1:-}" in
  accept) accept ;;
  run) run ;;
  *)
    log "usage: launcher.sh accept|run"
    exit 2
    ;;
esac
