# OpenInspect boxd Snapshot Tooling

Builds the boxd **base snapshots** used to create Open-Inspect boxd sandboxes.

The control plane talks to the boxd API directly at runtime (through the `@boxd-sh/sdk` web entry).
These files build base snapshots and provide the launcher baked into them.

## What's here

- **[Shared image package](../sandbox-images/README.md)**: owns the substrate, dependency pins,
  frozen installation bundle, runtime wheel, and verification.
- **`build-template.py`**: stages the shared bundle, installs it in a throwaway boxd machine through
  the boxd Python SDK (pinned in `uv.lock`), reboots it so the snapshot captures a clean boot of the
  installed image, saves the machine as a snapshot, and verifies a fresh restore from that name. Its
  machines are isolated (no metadata endpoint, no in-VM `boxd` CLI, none of the account's
  integrations or agent logins), private to the key, and carry a delete-after timer. Used both for
  manual builds and by the Terraform module.
- **`launcher.sh`**: baked at `/home/boxd/openinspect/launcher.sh`. The control plane starts it,
  detached, once a new session machine is up and its session env file is written, and again on every
  resume. It waits for the toolchain, holds a single-instance lock in `/tmp` (exit 75 means a
  runtime is already running, as when a resume wakes a hibernated machine), sources the session env
  from `/home/boxd/.openinspect/session.env`, picks the boot mode from the completed-boot marker the
  runtime writes (`OI_BOOT_COMPLETE_MARKER`), and execs `python -m sandbox_runtime.entrypoint` with
  its output in `/home/boxd/.openinspect/supervisor.log`.

The snapshot runs nothing of its own. On every session create the control plane restores it as an
isolated machine, writes the per-sandbox env (`CONTROL_PLANE_URL`, `SESSION_CONFIG`, auth token,
user secrets) to a file only the machine user can read, routes the session's ports, and starts the
launcher.

The build pins the image's git credential helper config (`/etc/gitconfig`) and `gh` wrapper
(`/usr/local/bin/gh`) immutable (`chattr +i`) before the reboot and the save, so they stay exactly
as built. A snapshot also keeps its source's labels, so the build machine drops its own
`openinspect-image-build` label before the save.

## Authentication

- **`BOXD_API_KEY`**: the key the control plane uses for the boxd API (and the code-server/VNC
  password HMAC), **and** what this build uses. Create it in the
  [boxd console](https://boxd.sh?ref=background-agents) under API keys. An org API key creates the
  machines and the snapshot in that org.

## Manual build

Use the repository-root [build command](../sandbox-images/README.md), or run the builder directly.
Native builds create unique `<prefix>-<12 hex>-<timestamp>` names and never overwrite the selected
snapshot. Select the verified name before directing traffic to it.

Base prefixes must be 1-46 lowercase letters, digits or dashes.

```bash
cd packages/boxd-infra
uv sync --frozen
export BOXD_API_KEY=bxd_…              # boxd console → API keys
export BOXD_BASE_SNAPSHOT=open-inspect # name prefix; the build appends a hash and timestamp
uv run --frozen python build-template.py
```

Optional: `BOXD_REGION` (default: the key's home region), `BOXD_ORG` (org the machines and snapshot
belong to), `BOXD_BUILD_SIZE` (default `2x8`; the snapshot keeps this size, and the control plane
resizes session machines that ask for another one).

Rebuild whenever `packages/sandbox-runtime`, `packages/sandbox-images` or this directory changes.

> Builds are automated via Terraform when `sandbox_provider = "boxd"`. The production
> `terraform/environments/production/boxd.tf` hashes the shared build inputs through the
> `sandbox-images` CLI, then passes the hash to `terraform/modules/boxd-infra` to build a new
> snapshot under a new name when those inputs change. The control-plane Worker switches only after
> verification. Superseded snapshots are not pruned automatically yet.

## Verification

Unit tests for the builder live in `packages/sandbox-images/tests/test_boxd_builder.py`; the bridge
↔ control-plane WebSocket path can only be exercised against a running control plane.

| Criterion                   | Test method                                                                |
| --------------------------- | -------------------------------------------------------------------------- |
| Fresh session works         | Bridge connects; agent responds to a prompt                                |
| Stop → resume works         | Idle stop hibernates the machine; the next prompt wakes it, files remain   |
| Cold start keeps the disk   | A stopped machine starts again and the runtime boots in restored mode      |
| code-server survives resume | Same URL and password work after resume                                    |
| Reserved ports are refused  | A tunnel or service on 57073 fails the spawn with a clear error            |
| Machines are isolated       | `ls /usr/local/bin/boxd` fails in a session machine; `/etc/gitconfig` kept |
