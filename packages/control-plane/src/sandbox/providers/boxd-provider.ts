/**
 * boxd sandbox provider — calls the boxd machine API through the boxd SDK's
 * web entry (grpc-web over `fetch`), wrapped by boxd-client.ts.
 *
 * A boxd sandbox is a full Ubuntu VM (a "machine") restored from a snapshot
 * the `boxd-infra` build saved: the sandbox image with the runtime and the
 * launcher baked in. A restore brings back the snapshot's memory and disk, so
 * it is fast and starts at the snapshot's size; a session that asks for a
 * different size is resized before anything runs on it. The create names the
 * machine deterministically, so a repeat after a lost answer is refused as a
 * taken name and the first machine is adopted rather than a second one billed.
 *
 * The per-sandbox env (secrets included) is written as a file only the
 * machine user can read, and the launcher sources it on every boot; nothing of it
 * goes into the machine's env or a command line. Ports are routed as named HTTPS proxies. The
 * launcher is started detached and watched briefly for an early exit; from
 * there readiness is the uniform contract: the sandbox bridge phones home, and
 * the connecting timeout fails the session otherwise.
 *
 * Stop hibernates: boxd saves the machine's memory and disk and releases its
 * host, so the shared lifecycle manager's persistent-resume path drives
 * idle-stop and resume, as it does for Daytona, E2B and Boat. A resume wakes
 * the machine with its processes as they were, so the launcher usually finds
 * the runtime still running (exit 75) and the bridge reconnects on its own. A
 * machine that was stopped cold instead (by hand, for example) loses
 * its memory but keeps its disk: the launcher then finds the marker the
 * runtime wrote when an earlier boot completed and starts the runtime in
 * `RESTORED_FROM_SNAPSHOT` mode, so the checkout is kept and `setup.sh` does
 * not run again. There is no session snapshot/restore pair here:
 * `evaluateSpawnDecision` consults `supportsPersistentResume` before any
 * snapshot id, so a stopped sandbox always resumes in place.
 *
 * A machine an org API key creates is private to the key unless shared. The
 * session env holds the sandbox auth token and user secrets, so a machine that
 * reports itself shared is made private before anything is written to it, and
 * the create fails closed if that cannot be done.
 */

import { bytesToHex } from "@open-inspect/shared/auth";
import type { SandboxSettings } from "@open-inspect/shared/types/integrations";
import { createLogger } from "../../logger";
import type { SourceControlProviderName } from "../../source-control";
import {
  BOXD_MACHINE_SIZES,
  BoxdApiError,
  BoxdCancelledError,
  BoxdConflictError,
  BoxdNotFoundError,
  boxdSizeResources,
  delayUnlessCancelled,
  type BoxdClient,
  type BoxdMachine,
  type BoxdMachineSize,
  type BoxdProxy,
} from "../boxd-client";
import { SANDBOX_RUNTIME_VERSION } from "../runtime-manifest";
import {
  buildSandboxEnvVars,
  DEFERRED_START_ENV_VAR,
  deriveCodeServerPassword,
  deriveVncPassword,
  IMAGE_BUILD_MODE_ENV_VAR,
  scmCloneIdentity,
} from "../sandbox-env";
import { resolveSandboxPortPlan, type SandboxPortPlan } from "./port-resolution";
import {
  createVncAccess,
  SandboxProviderError,
  signalUntilDeadline,
  type CreateSandboxConfig,
  type CreateSandboxResult,
  type ResumeConfig,
  type ResumeResult,
  type SandboxLifetime,
  type SandboxProvider,
  type SandboxProviderCapabilities,
  type StopConfig,
  type StopResult,
  type VncAccess,
} from "../provider";

const log = createLogger("boxd-provider");

/**
 * Runtime version reported by boxd sandboxes, so spawn-time selection can gate
 * on the compatibility floor. Derived from the manifest rather than pinned,
 * exactly as BOAT_SANDBOX_VERSION is.
 */
export const BOXD_SANDBOX_VERSION = SANDBOX_RUNTIME_VERSION;

/**
 * Ports reserved on every boxd machine. A session service or
 * tunnel there would never be reachable.
 */
export const BOXD_RESERVED_PORTS: ReadonlySet<number> = new Set([57073]);

/** Layout shared with the boxd-infra build and the launcher baked into the snapshot. */
const BOXD_USER_HOME = "/home/boxd";
/** The launcher the image build bakes into the snapshot (see packages/boxd-infra/launcher.sh). */
export const BOXD_LAUNCHER_PATH = `${BOXD_USER_HOME}/openinspect/launcher.sh`;
/** Per-machine state that must survive a cold boot: the session env, the launcher's log and exit. */
const BOXD_STATE_DIR = `${BOXD_USER_HOME}/.openinspect`;
/**
 * The session env, as `export NAME='value'` lines the launcher sources on
 * every boot. Mode 0600, owned by the machine user, and never on a command
 * line.
 */
export const BOXD_SESSION_ENV_FILE_PATH = `${BOXD_STATE_DIR}/session.env`;
const BOXD_SESSION_ENV_FILE_MODE = 0o600;
/** The launcher's own output, before it execs the runtime (whose output goes to the supervisor log). */
export const BOXD_LAUNCHER_LOG_PATH = `${BOXD_STATE_DIR}/launcher.log`;
/** The launcher's exit code, written by the detached wrapper when the launcher returns. */
export const BOXD_LAUNCHER_EXIT_PATH = `${BOXD_STATE_DIR}/launcher.exit`;
/** Where the runtime reads its tunnel URLs (TUNNEL_ENV_FILE_PATH in sandbox_runtime/constants.py). */
export const BOXD_TUNNEL_ENV_FILE_PATH = "/workspace/.tunnels.env";
// Mirrors TUNNEL_ENV_SANDBOX_ID_KEY in sandbox_runtime/constants.py: tags the
// tunnel env file with the sandbox it was written for, so the supervisor's
// stale-file cleanup keeps a fresh write instead of deleting it.
const TUNNEL_ENV_SANDBOX_ID_KEY = "TUNNEL_SANDBOX_ID";
const EXPECTED_TUNNEL_PORTS_ENV_VAR = "EXPECTED_TUNNEL_PORTS";
/** The launcher's exit code when a runtime already holds its single-instance lock. */
const LAUNCHER_ALREADY_RUNNING_EXIT_CODE = 75;

/**
 * The detached start of the launcher. The wrapper records the launcher's exit
 * code, so an exit within the settle window can be told from a launcher that
 * exec'd the runtime and is still running. No value of the session rides the
 * command line.
 */
export const BOXD_LAUNCH_COMMAND = [
  `rm -f ${BOXD_LAUNCHER_EXIT_PATH}`,
  `mkdir -p ${BOXD_STATE_DIR}`,
  `setsid nohup bash -c '${BOXD_LAUNCHER_PATH}; echo $? > ${BOXD_LAUNCHER_EXIT_PATH}' >>${BOXD_LAUNCHER_LOG_PATH} 2>&1 </dev/null &`,
].join(" && ");
const LAUNCH_COMMAND_TIMEOUT_SECONDS = 30;
const STATUS_COMMAND_TIMEOUT_SECONDS = 15;

/** Env names the launcher sources as shell assignments must be valid shell identifiers. */
const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Longest the deterministic machine name may be (one DNS label). */
const BOXD_MAX_NAME_CHARS = 63;
/** Label keys the provider writes on every machine it creates. */
export const BOXD_LABELS = {
  deployment: "openinspect-deployment",
  session: "openinspect-session",
  sandbox: "openinspect-sandbox",
  createKey: "openinspect-create-key",
} as const;
const BOXD_MAX_LABEL_VALUE_CHARS = 256;

/** Idempotent create attempts after a lost response. */
const CREATE_ATTEMPTS = 3;

/** How long a flow waits, and how often it looks, at each step of a machine's life. */
export interface BoxdLifecycleTimings {
  /** How often a flow waiting on a hibernate re-reads the machine's status. */
  pollIntervalMs: number;
  /** Pause between reads while a created, resized or resumed machine is still starting. */
  readyPollIntervalMs: number;
  /** Budget for a machine to report `running` and answer a command. */
  readyTimeoutMs: number;
  /** Budget for a hibernate when the caller set no deadline of its own. */
  stopTimeoutMs: number;
  /** How long a machine may stay `running` after a hibernate request before it is asked again. */
  hibernateRetryMs: number;
  /** How long a machine may stay `suspended` (preserved in memory) before the stop accepts it as is. */
  suspendedGraceMs: number;
  /**
   * How long the launcher is watched after a start for an early exit. The
   * window only has to catch a launcher that fails at once; a process still
   * running when it closes is the bridge's to report on, through its
   * phone-home and the connecting timeout, as on every provider.
   */
  launchSettleMs: number;
  launchPollIntervalMs: number;
  /** Pause before the first repeat of a create whose response was lost; later ones back off. */
  createRetryDelayMs: number;
}

const DEFAULT_BOXD_LIFECYCLE_TIMINGS: BoxdLifecycleTimings = {
  pollIntervalMs: 1_000,
  readyPollIntervalMs: 250,
  readyTimeoutMs: 120_000,
  stopTimeoutMs: 120_000,
  hibernateRetryMs: 15_000,
  suspendedGraceMs: 30_000,
  launchSettleMs: 1_500,
  launchPollIntervalMs: 500,
  createRetryDelayMs: 2_000,
};

/** Statuses in which a machine is on a host and takes commands. */
const BOXD_LIVE_STATUSES: ReadonlySet<string> = new Set(["running"]);
/** Statuses on the way to `running`. */
const BOXD_STARTING_STATUSES: ReadonlySet<string> = new Set(["pending", "starting", "migrating"]);
/** Statuses `wake` brings back with memory intact. */
const BOXD_SLEEPING_STATUSES: ReadonlySet<string> = new Set(["hibernated", "suspended"]);
/** Statuses with nothing left to resume. */
const BOXD_GONE_STATUSES: ReadonlySet<string> = new Set(["destroyed", "failed"]);

/** One port a session routes, and what it is for. */
interface BoxdPortRequest {
  kind: "codeServer" | "terminal" | "vnc" | "tunnel";
  port: number;
  /** The proxy's subdomain label under the machine's domain. */
  proxyName: string;
}

export interface BoxdProviderConfig {
  scmProvider: SourceControlProviderName;
  /** Secret used for domain-separated sandbox access password derivation. */
  sandboxAccessPasswordSecret: string;
  /** Snapshot every fresh sandbox restores from (built by boxd-infra). */
  baseSnapshot: string;
  /** Machine size when the session requests no CPU or memory. */
  defaultSize: BoxdMachineSize;
  /** Labels machines and keys idempotent creates; distinct per deployment. */
  deploymentName: string;
  /** Labels added to every machine (cost attribution, cleanup); the provider's own win on a clash. */
  extraLabels?: Record<string, string>;
}

interface BoxdAccess {
  codeServerUrl?: string;
  codeServerPassword?: string;
  ttydUrl?: string;
  vncAccess?: VncAccess;
  tunnelUrls?: Record<string, string>;
}

/**
 * How a hibernate ended. `hibernated` is the one outcome with saved state;
 * `timed_out` means the budget ran out before boxd confirmed it; `missing`
 * means boxd no longer has the machine; `unusable` means it ended in a state
 * nothing can resume.
 */
type BoxdHibernateOutcome =
  | { type: "hibernated" }
  | { type: "timed_out" }
  | { type: "missing" }
  | { type: "unusable"; detail: string };

/** Machine size for a resource request: the smallest one that fits, or the default. */
export function resolveBoxdMachineSize(
  settings: Pick<SandboxSettings, "cpuCores" | "memoryMib"> | undefined,
  fallback: BoxdMachineSize
): BoxdMachineSize {
  const cpuCores = settings?.cpuCores ?? null;
  const memoryMib = settings?.memoryMib ?? null;
  if (cpuCores === null && memoryMib === null) return fallback;
  for (const size of BOXD_MACHINE_SIZES) {
    const { vcpu, memoryGib } = boxdSizeResources(size);
    if (
      (cpuCores === null || vcpu >= cpuCores) &&
      (memoryMib === null || memoryGib * 1024 >= memoryMib)
    ) {
      return size;
    }
  }
  throw new SandboxProviderError(
    `Requested sandbox resources (cpuCores=${cpuCores ?? "default"}, memoryMib=${
      memoryMib ?? "default"
    }) exceed the largest boxd machine size`,
    "permanent"
  );
}

/**
 * Deterministic create key over deployment, session and sandbox: a retry of
 * the same launch names the same machine. The session is part of the identity
 * because a logical sandbox id is not unique on its own.
 */
export async function boxdCreateKey(
  deploymentName: string,
  sessionId: string,
  sandboxId: string
): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${deploymentName}:${sessionId}:${sandboxId}`)
  );
  return bytesToHex(new Uint8Array(digest));
}

/**
 * The machine's name: `<deployment>-<key>`. Machine names are unique across
 * boxd and form the machine's hostname, so the name is one DNS label of
 * lowercase letters, digits and dashes, starting with a letter; 16 hex
 * characters of the create key keep it unique while the deployment prefix
 * keeps it readable. A deployment name with no usable letters gets `oi`.
 */
export function boxdMachineName(deploymentName: string, createKey: string): string {
  const suffix = createKey.slice(0, 16);
  const slug = deploymentName
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[^a-z]+|-$/g, "")
    .slice(0, BOXD_MAX_NAME_CHARS - suffix.length - 1)
    .replace(/-$/, "");
  return `${slug || "oi"}-${suffix}`;
}

/** A label value boxd accepts: no control characters, at most 256 characters. */
function labelValue(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, BOXD_MAX_LABEL_VALUE_CHARS);
}

/** Single-quote a value for bash: everything literal, newlines included. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * The session env as a file the launcher sources: `export NAME='value'` per
 * line. A name that is not a shell identifier could not be exported, so it
 * fails the spawn rather than vanish; names travel in the error, values never.
 */
export function renderBoxdSessionEnvFile(envVars: Record<string, string>): string {
  const invalid = Object.keys(envVars).filter((key) => !ENV_KEY_PATTERN.test(key));
  if (invalid.length > 0) {
    throw new SandboxProviderError(
      `Sandbox env has ${invalid.length} name(s) that are not shell identifiers (${invalid
        .slice(0, 5)
        .join(", ")})`,
      "permanent"
    );
  }
  const lines = Object.entries(envVars)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `export ${key}=${shellQuote(value)}`);
  return `# Open-Inspect session env, written by the control plane.\n${lines.join("\n")}\n`;
}

/**
 * Whether a failed create may be repeated. A repeat is safe because the name
 * is deterministic: if the first create landed, the repeat is refused as a
 * taken name and the first machine is adopted.
 */
function isRetryableCreateFailure(error: unknown): boolean {
  if (error instanceof BoxdApiError) return error.transient;
  if (error instanceof BoxdCancelledError) return false;
  return SandboxProviderError.isTransientNetworkError(error);
}

/**
 * The control-plane classification of a failed boxd call, by gRPC code only.
 * Rate limits, unavailability and lost connections are boxd's moment, not a
 * broken deployment, so they stay off the circuit breaker; every other answer
 * says the request was wrong (a bad key, a missing snapshot, a size above the
 * org's quota).
 */
export function classifyBoxdError(message: string, error: unknown): SandboxProviderError {
  if (error instanceof SandboxProviderError) return error;
  if (error instanceof BoxdCancelledError) {
    // The budget ran out, not the provider: the obligation stays pending.
    return new SandboxProviderError(`${message}: ${error.message}`, "transient", error);
  }
  if (error instanceof BoxdApiError) {
    return new SandboxProviderError(
      `${message}: ${error.message}`,
      error.transient ? "transient" : "permanent",
      error
    );
  }
  const detail = error instanceof Error && error.message ? `: ${error.message}` : "";
  return SandboxProviderError.fromFetchError(`${message}${detail}`, error);
}

export class BoxdSandboxProvider implements SandboxProvider {
  readonly name = "boxd";

  readonly capabilities: SandboxProviderCapabilities = {
    // boxd has no absolute machine deadline to map a session lifetime onto;
    // the control plane's own inactivity and execution timers stop the
    // machine (see docs/BOXD_SANDBOX_PROVIDER.md).
    supportsSandboxTimeout: false,
    supportsSnapshots: false,
    supportsRestore: false,
    // Stop hibernates (memory and disk saved) and resume wakes the same
    // machine; the manager treats it as provider-managed state.
    supportsPersistentResume: true,
    supportsExplicitStop: true,
  };

  readonly timings: BoxdLifecycleTimings;

  constructor(
    private readonly client: BoxdClient,
    private readonly providerConfig: BoxdProviderConfig,
    timings: Partial<BoxdLifecycleTimings> = {}
  ) {
    this.timings = { ...DEFAULT_BOXD_LIFECYCLE_TIMINGS, ...timings };
  }

  async createSandbox(config: CreateSandboxConfig): Promise<CreateSandboxResult> {
    let machineId: string | undefined;
    try {
      const portPlan = this.resolvePortPlan(config);
      const size = resolveBoxdMachineSize(config.sandboxSettings, this.providerConfig.defaultSize);
      const { envVars, codeServerPassword, vncPassword } = await this.buildRuntimeEnv(
        config,
        portPlan
      );
      const envFile = renderBoxdSessionEnvFile(envVars);

      const machine = await this.createMachine(config);
      machineId = machine.id;
      await this.ensurePrivate(machine);

      const target = boxdSizeResources(size);
      if (machine.vcpu !== target.vcpu) {
        // A restore starts at the snapshot's size; moving it reboots the
        // machine, which is harmless before anything runs on it.
        await this.client.resizeMachine(machine.id, target.vcpu);
      }
      const ready = await this.waitForReady(machine.id);
      log.info("boxd.machine_ready", {
        sandbox_id: config.sandboxId,
        machine_id: machine.id,
        machine_name: ready.name,
        size,
      });

      // The env file goes in first, private to the machine user, then the
      // routes and the tunnel env file, then the launcher, so the runtime can
      // outrun none of them.
      await this.client.writeFile(machine.id, {
        path: BOXD_SESSION_ENV_FILE_PATH,
        content: envFile,
        mode: BOXD_SESSION_ENV_FILE_MODE,
        secretValues: envVars,
      });
      const access = await this.exposeAccess(
        machine.id,
        config.sandboxId,
        this.portRequests(portPlan),
        { codeServerPassword, vncPassword }
      );
      await this.launchRuntime(machine.id);

      return {
        sandboxId: config.sandboxId,
        providerObjectId: machine.id,
        createdAt: Date.now(),
        lifetime: this.lifetime(),
        ...access,
      };
    } catch (error) {
      // A machine that exists but could not be brought up would otherwise run
      // (and bill) until someone notices; delete it, then fail loudly.
      if (machineId) await this.deleteQuietly(machineId, "boxd.create_cleanup_failed");
      throw classifyBoxdError("Failed to create boxd sandbox", error);
    }
  }

  async resumeSandbox(config: ResumeConfig): Promise<ResumeResult> {
    const spawnFresh = (error: string): ResumeResult => ({
      success: false,
      error,
      shouldSpawnFresh: true,
    });
    try {
      const portPlan = this.resolvePortPlan(config);
      try {
        const machine = await this.client.getMachine(config.providerObjectId);
        if (BOXD_GONE_STATUSES.has(machine.status)) {
          return spawnFresh(`boxd machine is ${machine.status}; nothing left to resume`);
        }
        if (BOXD_SLEEPING_STATUSES.has(machine.status)) {
          // Hibernated by the idle stop, or by boxd's own idle timer: memory
          // and disk come back as they were.
          await this.client.wakeMachine(machine.id);
        } else if (machine.status === "stopped") {
          // Stopped cold (by hand, for example): the disk is kept and
          // the launcher boots the runtime in restored mode.
          await this.client.startMachine(machine.id);
        }

        const ready = await this.waitForReady(machine.id);
        await this.ensurePrivate(ready);
        const codeServerPassword = config.codeServerEnabled
          ? await deriveCodeServerPassword(
              config.sandboxId,
              this.providerConfig.sandboxAccessPasswordSecret
            )
          : undefined;
        const vncPassword = config.vncEnabled
          ? await deriveVncPassword(
              config.sandboxId,
              this.providerConfig.sandboxAccessPasswordSecret
            )
          : undefined;
        // Routes outlive a hibernate; any the session now wants that the
        // machine lacks are added, and the tunnel env file is rewritten.
        const access = await this.exposeAccess(
          machine.id,
          config.sandboxId,
          this.portRequests(portPlan),
          { codeServerPassword, vncPassword }
        );
        // On a woken machine the launcher finds the runtime still running and
        // exits 75; after a cold start it boots the runtime in restored mode.
        await this.launchRuntime(machine.id);

        return {
          success: true,
          providerObjectId: machine.id,
          lifetime: this.lifetime(),
          ...access,
        };
      } catch (error) {
        // boxd can remove the machine at any point (a delete-after timer, a
        // person in the console); every such disappearance takes the
        // fresh-spawn path.
        if (error instanceof BoxdNotFoundError) {
          return spawnFresh("Sandbox no longer exists in boxd");
        }
        throw error;
      }
    } catch (error) {
      throw classifyBoxdError("Failed to resume boxd sandbox", error);
    }
  }

  /**
   * Idle and heartbeat stops HIBERNATE (the manager routes them here via
   * supportsPersistentResume, and resumeSandbox wakes the machine). A
   * hibernate is confirmed only once boxd reports the machine `hibernated`
   * (or `stopped`, which keeps the disk). Terminal stops DELETE: nothing will
   * resume the machine, so its disk must not linger.
   */
  async stopSandbox(config: StopConfig): Promise<StopResult> {
    if (config.intent === "destroy") {
      const deadlineAtMs = config.deadlineAtMs ?? Date.now() + this.timings.stopTimeoutMs;
      const signal = signalUntilDeadline(deadlineAtMs, config.signal);
      try {
        await this.client.deleteMachine(config.providerObjectId, signal);
      } catch (error) {
        if (error instanceof BoxdNotFoundError) return { success: true };
        throw classifyBoxdError("Failed to delete boxd sandbox", error);
      }
      return { success: true };
    }

    let outcome: BoxdHibernateOutcome;
    try {
      outcome = await this.hibernate(config.providerObjectId, {
        signal: config.signal,
        deadlineAtMs: config.deadlineAtMs,
      });
    } catch (error) {
      throw classifyBoxdError("Failed to stop boxd sandbox", error);
    }
    switch (outcome.type) {
      case "hibernated":
        return { success: true };
      case "timed_out":
        return {
          success: false,
          error: "Timed out before boxd confirmed the machine was hibernated",
        };
      case "missing":
        return {
          success: false,
          error: "Sandbox disappeared before graceful shutdown was verified",
        };
      case "unusable":
        return { success: false, error: outcome.detail };
    }
  }

  /** No provider deadline: the control plane's own timers end the session. */
  private lifetime(): SandboxLifetime {
    return { kind: "none", observedAtMs: Date.now() };
  }

  /**
   * Restore the base snapshot under the deterministic name, repeating after a
   * lost response. A repeat that finds the name taken adopts the machine when
   * it carries this launch's create key, which only a create of the same
   * deployment, session and sandbox writes.
   */
  private async createMachine(config: CreateSandboxConfig): Promise<BoxdMachine> {
    const createKey = await boxdCreateKey(
      this.providerConfig.deploymentName,
      config.sessionId,
      config.sandboxId
    );
    const name = boxdMachineName(this.providerConfig.deploymentName, createKey);
    const labels = {
      ...this.providerConfig.extraLabels,
      [BOXD_LABELS.deployment]: labelValue(this.providerConfig.deploymentName),
      [BOXD_LABELS.session]: labelValue(config.sessionId),
      [BOXD_LABELS.sandbox]: labelValue(config.sandboxId),
      [BOXD_LABELS.createKey]: createKey,
    };
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.client.createFromSnapshot({
          snapshot: this.providerConfig.baseSnapshot,
          name,
          labels,
        });
      } catch (error) {
        if (error instanceof BoxdConflictError) {
          const adopted = await this.adoptExisting(name, createKey);
          if (adopted) return adopted;
          throw new SandboxProviderError(
            `boxd machine name ${name} is taken by a machine this launch did not create`,
            "permanent",
            error
          );
        }
        if (attempt >= CREATE_ATTEMPTS || !isRetryableCreateFailure(error)) throw error;
        log.warn("boxd.create_retry", {
          attempt,
          error: error instanceof Error ? error.message : String(error),
        });
        await delayUnlessCancelled(this.timings.createRetryDelayMs * attempt);
      }
    }
  }

  /** The machine under `name`, when an earlier attempt of this same launch created it. */
  private async adoptExisting(name: string, createKey: string): Promise<BoxdMachine | null> {
    let existing: BoxdMachine;
    try {
      existing = await this.client.getMachine(name);
    } catch (error) {
      // A name another account holds is invisible to this key.
      if (error instanceof BoxdNotFoundError) return null;
      throw error;
    }
    if (existing.labels[BOXD_LABELS.createKey] !== createKey) return null;
    if (BOXD_GONE_STATUSES.has(existing.status)) return null;
    log.info("boxd.create_adopted", { machine_id: existing.id, machine_name: name });
    return existing;
  }

  /**
   * Make sure a machine is private before anything of the session reaches it:
   * every member of an org can reach a shared machine, which would hand them
   * the session env. A machine created from a snapshot by an API key is
   * private, so this normally makes no call. Failing closed is the point: the
   * create deletes a machine that stays shared.
   */
  private async ensurePrivate(machine: BoxdMachine): Promise<void> {
    if (!machine.shared) return;
    await this.client.unshareMachine(machine.id);
    const updated = await this.client.getMachine(machine.id);
    if (updated.shared) {
      throw new SandboxProviderError(
        `boxd machine ${machine.id} stayed shared after unshare`,
        "permanent"
      );
    }
    log.info("boxd.machine_made_private", { machine_id: machine.id });
  }

  /**
   * Poll until the machine is `running` and answers a command. A machine that
   * ends in a terminal status on the way is a failed launch; one that is
   * merely slow fails transiently when the budget runs out.
   */
  private async waitForReady(machineId: string): Promise<BoxdMachine> {
    const deadlineAtMs = Date.now() + this.timings.readyTimeoutMs;
    for (;;) {
      const machine = await this.client.getMachine(machineId);
      if (BOXD_LIVE_STATUSES.has(machine.status)) {
        try {
          const probe = await this.client.exec(machineId, "true", {
            timeoutSeconds: STATUS_COMMAND_TIMEOUT_SECONDS,
          });
          if (probe.exitCode === 0) return machine;
        } catch (error) {
          // A machine that just booted may not answer a command yet.
          if (!(error instanceof BoxdApiError) || !error.transient) throw error;
        }
      } else if (machine.status === "destroyed") {
        throw new BoxdNotFoundError(`boxd machine ${machineId} was destroyed`);
      } else if (machine.status === "failed") {
        throw new SandboxProviderError(`boxd machine ${machineId} failed to start`, "permanent");
      } else if (
        !BOXD_STARTING_STATUSES.has(machine.status) &&
        !BOXD_SLEEPING_STATUSES.has(machine.status) &&
        machine.status !== "stopped"
      ) {
        throw new SandboxProviderError(
          `boxd machine is ${machine.status} while a running machine was expected`,
          "permanent"
        );
      }
      if (Date.now() >= deadlineAtMs) {
        throw new SandboxProviderError(
          `boxd machine did not become ready within ${this.timings.readyTimeoutMs}ms (status ${machine.status})`,
          "transient"
        );
      }
      await delayUnlessCancelled(this.timings.readyPollIntervalMs);
    }
  }

  /**
   * Start the baked launcher, detached, and watch it briefly: an exit within
   * the settle window means it never reached the runtime, or found one already
   * running (exit 75), which is the one exit that counts as success.
   * Readiness beyond that is the bridge's phone-home and the connecting
   * timeout, as everywhere.
   */
  private async launchRuntime(machineId: string): Promise<void> {
    const started = await this.client.exec(machineId, BOXD_LAUNCH_COMMAND, {
      timeoutSeconds: LAUNCH_COMMAND_TIMEOUT_SECONDS,
    });
    if (started.exitCode !== 0) {
      throw new SandboxProviderError(
        `boxd runtime launch command exited with code ${started.exitCode}${tailDetail(
          started.stderr || started.stdout
        )}`,
        "permanent"
      );
    }
    const settleUntilMs = Date.now() + this.timings.launchSettleMs;
    for (;;) {
      await delayUnlessCancelled(this.timings.launchPollIntervalMs);
      const status = await this.client.exec(
        machineId,
        `cat ${BOXD_LAUNCHER_EXIT_PATH} 2>/dev/null || true`,
        { timeoutSeconds: STATUS_COMMAND_TIMEOUT_SECONDS }
      );
      const exited = status.stdout.trim();
      if (exited !== "") {
        const exitCode = Number(exited);
        if (exitCode === LAUNCHER_ALREADY_RUNNING_EXIT_CODE) {
          log.info("boxd.runtime_already_running", { machine_id: machineId });
          return;
        }
        const logTail = await this.client
          .exec(machineId, `tail -c 400 ${BOXD_LAUNCHER_LOG_PATH} 2>/dev/null || true`, {
            timeoutSeconds: STATUS_COMMAND_TIMEOUT_SECONDS,
          })
          .then((result) => result.stdout)
          .catch(() => "");
        throw new SandboxProviderError(
          `boxd runtime launcher exited with code ${exited}${tailDetail(logTail)}`,
          "permanent"
        );
      }
      if (Date.now() >= settleUntilMs) {
        log.info("boxd.runtime_started", { machine_id: machineId });
        return;
      }
    }
  }

  /**
   * Hibernate the machine and wait for boxd to confirm it. boxd freezes the
   * machine first (`suspended`, memory held on the host) and then writes it to
   * disk (`hibernated`). A machine already hibernated (boxd's own idle timer
   * can get there first) or stopped is read rather than hibernated again.
   *
   * Two guards keep a stop from waiting out the caller's whole budget: a
   * machine still `running` well after the request is asked again (the
   * request is idempotent), and one that stays `suspended` past a grace
   * period counts as preserved, since a suspended machine also wakes with its
   * memory and disk and is not billed for CPU or memory. A read that fails
   * transiently is retried within the budget.
   *
   * Answers with what actually happened rather than throwing on a budget that
   * ran out; a call boxd refused is thrown as is, for the caller to classify.
   */
  private async hibernate(
    machineId: string,
    options: { signal?: AbortSignal; deadlineAtMs?: number }
  ): Promise<BoxdHibernateOutcome> {
    const startedAtMs = Date.now();
    const deadlineAtMs = options.deadlineAtMs ?? startedAtMs + this.timings.stopTimeoutMs;
    const signal = signalUntilDeadline(deadlineAtMs, options.signal);
    const requestHibernate = async (): Promise<"sent" | "missing"> => {
      try {
        await this.client.hibernateMachine(machineId, signal);
      } catch (error) {
        if (error instanceof BoxdNotFoundError) return "missing";
        // boxd refuses to hibernate a machine that is not running; the reads
        // below decide whether it already holds its state.
        if (!(error instanceof BoxdConflictError)) throw error;
      }
      return "sent";
    };
    const settled = (outcome: BoxdHibernateOutcome, status: string): BoxdHibernateOutcome => {
      log.info("boxd.hibernate_settled", {
        machine_id: machineId,
        outcome: outcome.type,
        status,
        duration_ms: Date.now() - startedAtMs,
      });
      return outcome;
    };
    try {
      if ((await requestHibernate()) === "missing") return settled({ type: "missing" }, "missing");
      let requestedAtMs = Date.now();
      let suspendedSinceMs: number | undefined;
      for (;;) {
        let current: BoxdMachine | undefined;
        try {
          current = await this.client.getMachine(machineId, signal);
        } catch (error) {
          if (error instanceof BoxdNotFoundError) return settled({ type: "missing" }, "missing");
          const transient =
            (error instanceof BoxdApiError && error.transient) ||
            SandboxProviderError.isTransientNetworkError(error);
          if (!transient) throw error;
        }
        const status = current?.status;
        if (status === "hibernated" || status === "stopped") {
          return settled({ type: "hibernated" }, status);
        }
        if (status === "destroyed") return settled({ type: "missing" }, status);
        if (status === "failed") {
          return settled(
            { type: "unusable", detail: "boxd machine failed while hibernating" },
            status
          );
        }
        const nowMs = Date.now();
        if (status === "suspended") {
          suspendedSinceMs ??= nowMs;
          if (nowMs - suspendedSinceMs >= this.timings.suspendedGraceMs) {
            log.warn("boxd.hibernate_left_suspended", { machine_id: machineId });
            return settled({ type: "hibernated" }, status);
          }
        } else {
          suspendedSinceMs = undefined;
          if (status === "running" && nowMs - requestedAtMs >= this.timings.hibernateRetryMs) {
            log.warn("boxd.hibernate_retry", { machine_id: machineId, status });
            if ((await requestHibernate()) === "missing") {
              return settled({ type: "missing" }, "missing");
            }
            requestedAtMs = Date.now();
          }
        }
        await delayUnlessCancelled(this.timings.pollIntervalMs, signal);
      }
    } catch (error) {
      if (error instanceof BoxdCancelledError || signal?.aborted) {
        return settled({ type: "timed_out" }, "unknown");
      }
      throw error;
    }
  }

  /** Best-effort delete for a machine we are abandoning; never masks the original error. */
  private async deleteQuietly(machineId: string, event: string): Promise<void> {
    try {
      await this.client.deleteMachine(machineId);
    } catch (error) {
      if (error instanceof BoxdNotFoundError) return;
      log.warn(event, {
        machine_id: machineId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Effective ports for a sandbox. A port boxd reserves is rejected
   * outright: a service bound there is unreachable.
   */
  private resolvePortPlan(
    config: Pick<CreateSandboxConfig, "codeServerEnabled" | "vncEnabled" | "sandboxSettings">
  ): SandboxPortPlan {
    const settings: SandboxSettings = { ...config.sandboxSettings };
    const plan = resolveSandboxPortPlan(
      {
        codeServer: config.codeServerEnabled === true,
        terminal: settings.terminalEnabled === true,
        vnc: config.vncEnabled === true,
      },
      settings
    );
    const reserved = plan.allExposedPorts.filter((port) => BOXD_RESERVED_PORTS.has(port));
    if (reserved.length > 0) {
      throw new SandboxProviderError(
        `Sandbox port(s) ${reserved.join(", ")} are reserved by boxd (${[...BOXD_RESERVED_PORTS].join(", ")})`,
        "permanent"
      );
    }
    return plan;
  }

  /** Assemble the session env (and the derived service passwords) for a create. */
  private async buildRuntimeEnv(
    config: CreateSandboxConfig,
    portPlan: SandboxPortPlan
  ): Promise<{
    envVars: Record<string, string>;
    codeServerPassword?: string;
    vncPassword?: string;
  }> {
    const codeServerPassword = config.codeServerEnabled
      ? await deriveCodeServerPassword(
          config.sandboxId,
          this.providerConfig.sandboxAccessPasswordSecret
        )
      : undefined;
    const vncPassword = config.vncEnabled
      ? await deriveVncPassword(config.sandboxId, this.providerConfig.sandboxAccessPasswordSecret)
      : undefined;
    const envVars = buildSandboxEnvVars(config, {
      scmIdentity: scmCloneIdentity(this.providerConfig.scmProvider),
      codeServerPassword,
      vncPassword,
      portPlan,
    });

    // Every boot marker is stated, never merely omitted, so a repo secret of
    // the same name cannot decide how the runtime boots. The launcher raises
    // RESTORED_FROM_SNAPSHOT itself on every boot after the first.
    Object.assign(envVars, {
      [DEFERRED_START_ENV_VAR]: "false",
      [IMAGE_BUILD_MODE_ENV_VAR]: "false",
      RESTORED_FROM_SNAPSHOT: "false",
      FROM_REPO_IMAGE: "false",
      // So the runtime reports a version (spawn-time selection gates on it).
      SANDBOX_VERSION: BOXD_SANDBOX_VERSION,
    });
    if (portPlan.extraTunnelPorts.length > 0) {
      envVars[EXPECTED_TUNNEL_PORTS_ENV_VAR] = portPlan.extraTunnelPorts.join(",");
    }
    return { envVars, codeServerPassword, vncPassword };
  }

  /** The ports a session routes, each on a named proxy under the machine's domain. */
  private portRequests(portPlan: SandboxPortPlan): BoxdPortRequest[] {
    const requests: BoxdPortRequest[] = [];
    if (portPlan.codeServerPort !== undefined) {
      requests.push({ kind: "codeServer", port: portPlan.codeServerPort, proxyName: "code" });
    }
    if (portPlan.terminalPort !== undefined) {
      requests.push({ kind: "terminal", port: portPlan.terminalPort, proxyName: "terminal" });
    }
    if (portPlan.vncPort !== undefined) {
      requests.push({ kind: "vnc", port: portPlan.vncPort, proxyName: "vnc" });
    }
    for (const port of portPlan.extraTunnelPorts) {
      requests.push({ kind: "tunnel", port, proxyName: `port-${port}` });
    }
    return requests;
  }

  /**
   * Route every requested port, assemble the access the session gets, and
   * write the tunnel env file into the workspace. A route the machine already
   * has (a resume) is reused; any other is created. A port that still fails is
   * logged and left out: the session runs without that link rather than not
   * at all.
   */
  private async exposeAccess(
    machineId: string,
    logicalSandboxId: string,
    requests: BoxdPortRequest[],
    passwords: { codeServerPassword?: string; vncPassword?: string }
  ): Promise<BoxdAccess> {
    if (requests.length === 0) return {};
    let proxies: BoxdProxy[] = await this.client.listProxies(machineId);
    const missing = requests.filter(
      (request) =>
        !proxies.some((proxy) => proxy.name === request.proxyName && proxy.port === request.port)
    );
    if (missing.length > 0) {
      const created = await Promise.allSettled(
        missing.map((request) =>
          this.client.createProxy(machineId, request.proxyName, request.port)
        )
      );
      for (const [index, outcome] of created.entries()) {
        if (outcome.status === "rejected") {
          log.warn("boxd.create_proxy_failed", {
            sandbox_id: logicalSandboxId,
            access_kind: missing[index].kind,
            port: missing[index].port,
            error:
              outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason),
          });
        }
      }
      proxies = await this.client.listProxies(machineId);
    }

    const access: BoxdAccess = {};
    const tunnelUrls: Record<string, string> = {};
    for (const request of requests) {
      const proxy = proxies.find(
        (candidate) => candidate.name === request.proxyName && candidate.port === request.port
      );
      if (!proxy) continue;
      const url = `https://${proxy.domain}`;
      if (request.kind === "codeServer") {
        access.codeServerUrl = url;
        access.codeServerPassword = passwords.codeServerPassword;
      } else if (request.kind === "terminal") {
        access.ttydUrl = url;
      } else if (request.kind === "vnc") {
        access.vncAccess = createVncAccess(url, passwords.vncPassword);
      } else {
        tunnelUrls[String(request.port)] = url;
      }
    }
    if (Object.keys(tunnelUrls).length > 0) {
      access.tunnelUrls = tunnelUrls;
      await this.writeTunnelEnvFile(machineId, logicalSandboxId, tunnelUrls);
    }
    return access;
  }

  private async writeTunnelEnvFile(
    machineId: string,
    logicalSandboxId: string,
    tunnelUrls: Record<string, string>
  ): Promise<void> {
    const lines = [
      `${TUNNEL_ENV_SANDBOX_ID_KEY}=${logicalSandboxId}`,
      ...Object.entries(tunnelUrls)
        .sort(([a], [b]) => Number(a) - Number(b))
        .map(([port, url]) => `TUNNEL_${port}=${url}`),
    ];
    await this.client.writeFile(machineId, {
      path: BOXD_TUNNEL_ENV_FILE_PATH,
      content: lines.join("\n") + "\n",
    });
  }
}

function tailDetail(text: string): string {
  const detail = text.trim().slice(-400);
  return detail ? `: ${detail}` : "";
}

export function createBoxdProvider(
  client: BoxdClient,
  providerConfig: BoxdProviderConfig
): BoxdSandboxProvider {
  return new BoxdSandboxProvider(client, providerConfig);
}
