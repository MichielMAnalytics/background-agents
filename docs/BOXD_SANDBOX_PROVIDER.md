# boxd Sandbox Provider

Open-Inspect can use [boxd](https://boxd.sh?ref=background-agents) as the sandbox provider for
coding sessions. The control plane talks directly to the boxd API from Cloudflare Workers (or the
Node host), through the boxd TypeScript SDK's `fetch`-only web entry. There is no separate service
to deploy for this provider; only the base snapshot is built (by Terraform, or manually).

## When to Use It

Use `sandbox_provider = "boxd"` when you want sandbox sessions to run in boxd's full Ubuntu virtual
machines (real `systemd`, Docker, passwordless `sudo`) while keeping the same Open-Inspect control
plane, web app, GitHub OAuth, and Slack/GitHub integrations. A session machine is restored from a
memory-and-disk snapshot in well under a second. Idle sessions are hibernated: boxd saves the
machine's memory and disk and releases its host, and the next prompt wakes the same machine with its
files and its processes as they were.

## Required Configuration

Set these values in `terraform/environments/production/terraform.tfvars`:

```hcl
sandbox_provider = "boxd"

boxd_api_key       = "bxd_..."       # from the boxd console → API keys
boxd_base_snapshot = "open-inspect"  # prefix of the snapshot to build/use

# Optional
# boxd_region         = ""     # region machines live in (fra, nyc, ...); empty = the key's home region
# boxd_org            = ""     # org machines are created in and billed to; empty = the key's own org
# boxd_sandbox_size   = "2x8"  # machine size when a session requests no resources
# boxd_machine_labels = {}     # extra labels on every session machine, e.g. { team = "platform" }
```

For GitHub Actions-based deployment, configure the matching repository secrets and variables:

```text
SANDBOX_PROVIDER=boxd
BOXD_API_KEY
BOXD_BASE_SNAPSHOT
BOXD_REGION         # optional
BOXD_ORG            # optional
BOXD_SANDBOX_SIZE   # optional
```

The boxd provider also needs the normal Open-Inspect values such as Cloudflare, GitHub App, and web
app configuration. See [GETTING_STARTED.md](./GETTING_STARTED.md) for the full deployment flow.

`boxd_base_snapshot` is the Terraform name prefix: snapshots use `<prefix>-<16 lowercase hex>` from
the build-input hash. Keep the prefix to 46 lowercase letters, digits or dashes. Use a unique prefix
for each deployment sharing a boxd org.

### Isolation and privacy

Every machine the provider creates (session machines and the snapshot build's own machines) is
**isolated** and **private**:

- **Isolated**: no metadata endpoint, no in-VM `boxd` CLI, none of the API key owner's integrations
  (GitHub, Slack, ...) or coding-agent logins. Code the agent runs cannot act as the key's owner or
  manage the org's machines. Isolation is one-way and is inherited by everything restored from the
  snapshot.
- **Private**: a machine an org API key creates is visible to the key only. A machine that reports
  itself shared is made private before anything of the session is written to it, and a create fails
  closed (and deletes the machine) when that cannot be done.

The session env (`CONTROL_PLANE_URL`, `SESSION_CONFIG`, the sandbox auth token, user secrets) never
rides a command line or the machine's env. It is written as `/home/boxd/.openinspect/session.env`,
mode `0600`, which the launcher sources on every boot.

## Snapshot Build

boxd sandboxes restore from a **snapshot** that contains:

- the Open-Inspect sandbox runtime (`packages/sandbox-runtime`, reachable as `/app`)
- OpenCode and the OpenCode plugin dependencies
- Python 3.12 and Node 24 runtimes under `/opt/openinspect`
- `code-server`, `ttyd`, `agent-browser`, and the browser/desktop tooling used by the agent runtime
- GitHub CLI and a Git credential helper
- the launcher (`/home/boxd/openinspect/launcher.sh`) that starts the runtime on every boot

The snapshot is built by `packages/boxd-infra/build-template.py` from the shared image bundle
([`packages/sandbox-images`](../packages/sandbox-images/README.md)): an isolated build machine is
created from boxd's stock Ubuntu 24.04 image, the bundle is installed in it, the machine is rebooted
so the snapshot captures a clean boot of the installed image, and it is saved under the name. A
second machine then restores that name and runs the image verification. Both machines carry a
platform-enforced delete-after timer, so a build that dies half-way never leaves one running.

The build pins the image's git credential helper config (`/etc/gitconfig`) and `gh` wrapper
(`/usr/local/bin/gh`) immutable (`chattr +i`) before the snapshot is saved, so they stay exactly as
built.

### Terraform-Managed Snapshot

This is the recommended path for a normal deployment. When `sandbox_provider = "boxd"`, the
production `boxd.tf` computes the build-input hash through the `sandbox-images` CLI, covering the
runtime, image package, boxd builder and Terraform module. It passes that hash to
`terraform/modules/boxd-infra`, which builds a new snapshot under a new name on `terraform apply`
when those inputs change. The control-plane Worker switches to the new name only after the build has
verified it.

```bash
cd terraform/environments/production
terraform init
terraform apply
```

Superseded base snapshots are not pruned automatically yet; delete old `<prefix>-<16 hex>` names in
the boxd console (Snapshots) or with `boxd snapshots rm <name>` once no deployment uses them.

### Manual Snapshot

Use this path to build or test a snapshot before wiring it into Terraform:

```bash
cd packages/boxd-infra
uv sync --frozen
export BOXD_API_KEY=bxd_…
export BOXD_BASE_SNAPSHOT=open-inspect
uv run --frozen python build-template.py
```

Optional: `BOXD_REGION`, `BOXD_ORG`, and `BOXD_BUILD_SIZE` (default `2x8`: the size of the machine
the image is installed on, which the snapshot keeps). Manual builds use
`<prefix>-<12 hex>-<timestamp>` names. The command prints `{"reference": "<snapshot name>"}`; set
that name as `BOXD_BASE_SNAPSHOT` on the control plane. See
[`packages/boxd-infra/README.md`](../packages/boxd-infra/README.md) for details.

## Runtime Behavior

The boxd provider creates fresh sandboxes from the snapshot:

1. the machine is restored from the snapshot, isolated, under a deterministic name
   (`<deployment>-<16 hex>`, from the deployment, session and sandbox ids) with labels naming the
   deployment, session and sandbox. A create whose answer was lost is repeated; the repeat finds the
   name taken and adopts the machine the first one made, so no second machine is billed
2. a session that asks for a different size than the snapshot's is resized (boxd reboots the
   machine, before anything runs on it)
3. the control plane writes the session env file, routes the enabled service ports (code-server,
   terminal, noVNC) and the configured tunnel ports as named HTTPS proxies
   (`https://<name>.<machine>.boxd.sh`), and writes the tunnel URLs to `/workspace/.tunnels.env`
4. it starts the launcher, detached, and watches it briefly for an early exit. The launcher waits
   for the toolchain, takes a single-instance lock, sources the session env, and execs the
   supervisor (`python -m sandbox_runtime.entrypoint`) with its output in
   `/home/boxd/.openinspect/supervisor.log`. The supervisor records a completed boot in
   `/home/boxd/.openinspect/boot-complete`; a later boot that finds it starts in restored mode
5. the supervisor clones or syncs the selected repositories, starts OpenCode and code-server, and
   connects the Open-Inspect bridge back to the control plane; readiness is the bridge phoning home,
   and the shared connecting timeout fails the session otherwise

Machine size follows the session's sandbox settings: a `cpuCores`/`memoryMib` request selects the
smallest boxd size that satisfies it (`1x4`, `2x8`, `4x16`, `8x32`, vCPU × GiB, up to your org's
quota), and a session without a request uses `boxd_sandbox_size`.

boxd has no absolute machine deadline, so the session lifetime setting (`sandboxTimeoutMs`) is not
offered for this provider (as for Daytona). The control plane's own inactivity and execution timers
stop the machine.

Prebuilt repository and environment images are not supported on boxd yet; sessions boot from the
base snapshot and run `.openinspect/setup.sh` on their first boot.

### Ports

Port 57073 is reserved on every boxd machine; a sandbox setting that puts a service or tunnel there
is rejected at spawn time.

### Access URLs

Every route is a named boxd proxy, which boxd never puts behind its browser check, so the terminal
iframe and non-browser clients reach it. boxd proxies carry no token of their own: code-server, the
terminal and noVNC are guarded by their own password or token, but **tunnel URLs are public**. Treat
a tunnel URL like a password, and do not expose a service on a tunnel port that has no
authentication of its own. The first named route on a machine triggers a certificate for
`*.<machine>.boxd.sh`, which takes up to a minute; until then the URL answers with a TLS error.

## Lifecycle: Stop and Resume

Open-Inspect drives the lifecycle through the shared lifecycle manager, treating a boxd stop as a
**resumable hibernate**:

- Idle sessions are **stopped** after the shared inactivity timeout (default 10 minutes): boxd
  hibernates the machine, saving its memory and disk. The stop is confirmed only once boxd reports
  the machine `hibernated`.
- The next prompt **resumes** the same machine: a hibernated (or suspended) machine is woken with
  its processes as they were, so the runtime is still running, the launcher finds its lock taken and
  exits at once, and the bridge reconnects on its own. A machine that was stopped cold instead (by
  hand, for example) keeps its disk but not its memory; it is started again and the launcher boots
  the runtime in restored mode, so the checkout is kept and `setup.sh` does not run twice. The proxy
  URLs stay the same across a stop and resume, and so do the code-server and VNC passwords.
- boxd's own idle timer can hibernate a machine before the control plane does (orgs default to four
  hours of no network traffic). That is harmless: the next prompt wakes it the same way.
- A machine that boxd no longer has (deleted in the console, or by a delete-after timer) is replaced
  by a fresh one on the next prompt.
- Only machines that fail before becoming usable, or are being replaced or archived, are
  **deleted**.

A hibernated machine is billed for its disk only, not for CPU or memory.

## Required Secrets

Terraform passes these provider-level values to the control plane:

- `BOXD_API_KEY`: used for the boxd API **and** the code-server/VNC password HMAC at create time,
  and to authenticate the snapshot build
- `BOXD_BASE_SNAPSHOT`, `BOXD_SANDBOX_SIZE`
- `BOXD_REGION`, `BOXD_ORG`, `BOXD_LABELS` (optional)

Model credentials are not among them: boxd sandboxes take every LLM API key from Open-Inspect's
secrets settings, so add `ANTHROPIC_API_KEY` there for Claude models and the equivalent key for any
other provider you use. See [SECRETS.md](./SECRETS.md).

## Verify

After `terraform apply`, verify:

1. The control plane is healthy:

   ```bash
   curl https://open-inspect-control-plane-<deployment_name>.<workers-subdomain>.workers.dev/health
   ```

2. `boxd snapshots list` (or the console's Snapshots page) lists the Open-Inspect snapshot as
   `ready`.

3. Starting a session in the web app creates a boxd machine
   (`boxd machine list --label openinspect-deployment=<deployment_name>`) and reaches `Connected`.

4. Inside the session, ask a simple repo question such as:

   ```text
   tell me about this repository
   ```

If a session starts but never produces agent output, check the control-plane logs for runtime
startup, bridge connection, and OpenCode health events. The in-machine forensics files are
`/home/boxd/.openinspect/launcher.log` and `/home/boxd/.openinspect/supervisor.log`, reachable with
`boxd machine exec <machine> -- tail /home/boxd/.openinspect/supervisor.log` while the machine
exists.

## Common Issues

### Snapshot Was Not Built

When `sandbox_provider = "boxd"`, Terraform builds the snapshot during `terraform apply`, keyed on a
hash of the runtime, image package and builder sources. To force a rebuild, change a hashed source
file. For a manual build, set `BOXD_BASE_SNAPSHOT` on the control plane to the exact name the build
printed.

### Spawns Fail With a Quota Error

boxd limits machine sizes and the number of machines per org. A session that asks for more than the
org's quota fails to spawn with boxd's message; raise the quota or lower `boxd_sandbox_size`.

### Missing Repository Access

Repository access comes from the configured GitHub App installation, not from boxd's GitHub
integration (session machines are isolated and do not get it). If a sandbox cannot clone a repo,
check the GitHub App installation permissions.

## References

- [boxd docs](https://docs.boxd.sh?ref=background-agents)
- [boxd agent reference](https://boxd.sh/llms.txt?ref=background-agents)
- [TypeScript SDK](https://www.npmjs.com/package/@boxd-sh/sdk) and
  [Python SDK](https://pypi.org/project/boxd/)
