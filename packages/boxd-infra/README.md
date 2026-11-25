# boxd sandbox image

Builds the base snapshot the `boxd` sandbox provider creates session machines from, and holds what
that snapshot runs. The provider and its setup are described in
[docs/BOXD_SANDBOX_PROVIDER.md](../../docs/BOXD_SANDBOX_PROVIDER.md).

| File                          | Installed at                                      | Role                                                                                            |
| ----------------------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `build-snapshot.py`           | (build host)                                      | Builds and verifies the snapshot; run through `npm run sandbox:images -- build --provider boxd` |
| `launcher.sh`                 | `/opt/openinspect/boxd/launcher.sh`               | `accept`: takes the session from the inbox and starts the service; `run`: starts the runtime    |
| `exec-runtime.py`             | `/opt/openinspect/boxd/exec-runtime.py`           | Validates the session environment and execs the runtime as `user` without exposing it           |
| `openinspect-sandbox.service` | `/etc/systemd/system/openinspect-sandbox.service` | Runs the launcher on every start of a machine that holds a session                              |

## Build

```bash
export BOXD_API_KEY=bxd_...      # a key for the org the sandboxes run in
export BOXD_REGION=fra           # optional; the key's region otherwise
npm run sandbox:images -- build --provider boxd --output /tmp/boxd-image.json
```

Optional: `BOXD_ORG` (defaults to the key's org) and `BOXD_SNAPSHOT_PREFIX` (default
`openinspect-sandbox`).

The snapshot is named `<prefix>-<16 hex build hash>`. A build whose snapshot already exists
re-verifies it instead of building again. The build machine and the verification machine are
isolated, carry the label `openinspect/image-build`, and are deleted when the build ends, including
on failure. Build in the region the control plane's `BOXD_REGION` names.

## Boot sequence

1. The control plane creates an isolated machine from the snapshot and writes the session
   environment to `/home/boxd/.openinspect/session.json` (mode `0600`), and the tunnel URLs, when
   the session has tunnel ports, to `/home/boxd/.openinspect/tunnels.env`.
2. It runs `sudo /opt/openinspect/boxd/launcher.sh accept`. The launcher checks the environment,
   keeps it at `/etc/openinspect/session.json` (root only), moves the tunnel URLs to
   `/workspace/.tunnels.env`, and starts `openinspect-sandbox.service`.
3. The service starts the runtime as `user`, in restored mode when an earlier boot on this disk
   completed.
4. A hibernated machine wakes with the runtime still running; `accept` then changes nothing. A
   stopped machine boots again and the enabled service starts the runtime from the kept environment.
