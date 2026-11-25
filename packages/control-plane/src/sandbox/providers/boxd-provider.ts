/**
 * boxd sandbox provider.
 *
 * A boxd sandbox is an isolated microVM created from the base snapshot that
 * `packages/boxd-infra` builds (the shared sandbox image with the runtime and
 * its boot files installed). The control plane writes the session environment
 * into the machine's inbox (mode 0600) and runs `launcher.sh accept`, which
 * keeps it root-only under /etc/openinspect and starts
 * `openinspect-sandbox.service`. Readiness is the uniform contract: the
 * sandbox bridge phones home, and the connecting timeout fails the session
 * otherwise.
 *
 * Stop is a hibernate: boxd writes the machine's memory and disk to storage
 * and releases the host, and a resume wakes it with every process where it
 * was, so the runtime reconnects its bridge and carries on. The shared
 * lifecycle manager's persistent-resume path drives idle-stop and resume, as
 * it does for Daytona. A machine that was stopped instead boots again: the
 * service is enabled and starts the runtime in restored mode from the kept
 * environment. Terminal stops delete the machine.
 *
 * code-server, the terminal, the desktop and tunnel ports are named HTTPS
 * proxies created with the machine (`<name>.<machine>.boxd.sh`). The URLs are
 * public: code-server and the desktop are guarded by their own derived
 * passwords, as on the other providers.
 */

import { supportsConfigurableSandboxTimeout } from "@open-inspect/shared/types/integrations";
import { createLogger } from "../../logger";
import type { SourceControlProviderName } from "../../source-control";
import { BoxdApiError, type BoxdMachine, type BoxdSandboxApi } from "../boxd-api";
import {
  createVncAccess,
  SandboxLaunchRejectedError,
  SandboxProviderError,
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
import {
  buildSandboxEnvVars,
  DEFERRED_START_ENV_VAR,
  deriveCodeServerPassword,
  deriveVncPassword,
  IMAGE_BUILD_MODE_ENV_VAR,
  scmCloneIdentity,
} from "../sandbox-env";
import { SANDBOX_RUNTIME_VERSION } from "../runtime-manifest";
import { resolveSandboxPortPlan, type SandboxPortPlan } from "./port-resolution";

const log = createLogger("boxd-provider");

/** Machine names are `<prefix>-<hash of the sandbox id>`; the prefix keeps them apart per deployment. */
export const DEFAULT_BOXD_MACHINE_PREFIX = "openinspect";
const BOXD_MACHINE_PREFIX_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;
const MACHINE_NAME_HASH_CHARS = 16;

export const BOXD_DEPLOYMENT_LABEL = "openinspect/deployment";
export const BOXD_SESSION_LABEL = "openinspect/session-id";
export const BOXD_SANDBOX_LABEL = "openinspect/sandbox-id";

// Paths shared with packages/boxd-infra (launcher.sh, build-snapshot.py).
export const BOXD_SESSION_INBOX_PATH = "/home/boxd/.openinspect/session.json";
export const BOXD_TUNNEL_INBOX_PATH = "/home/boxd/.openinspect/tunnels.env";
export const BOXD_ACCEPT_COMMAND = "sudo /opt/openinspect/boxd/launcher.sh accept";
const PRIVATE_FILE_MODE = 0o600;

// Mirrors TUNNEL_ENV_SANDBOX_ID_KEY in sandbox_runtime/constants.py.
const TUNNEL_ENV_SANDBOX_ID_KEY = "TUNNEL_SANDBOX_ID";
const EXPECTED_TUNNEL_PORTS_ENV_VAR = "EXPECTED_TUNNEL_PORTS";

/**
 * Runtime version boxd sandboxes report, so the control plane knows the
 * runtime speaks the confirmed-shutdown protocol when it resumes one. Derived
 * from the manifest rather than pinned, exactly as E2B_SANDBOX_VERSION is.
 */
export const BOXD_SANDBOX_VERSION = SANDBOX_RUNTIME_VERSION;

/** How long a new or woken machine may take to answer an exec round trip. */
const BOXD_READY_TIMEOUT_MS = 180_000;
/** Budget for the one command that hands the session to the machine. */
const ACCEPT_TIMEOUT_MS = 60_000;

export interface BoxdProviderTimings {
  /** How long a stop waits for boxd to report the machine hibernated, without a caller deadline. */
  hibernateTimeoutMs: number;
  /** How long a resume waits for a stopped machine to start booting. */
  startTimeoutMs: number;
  /** Interval between reads while a hibernate or start settles. */
  pollIntervalMs: number;
}

const DEFAULT_BOXD_TIMINGS: BoxdProviderTimings = {
  hibernateTimeoutMs: 180_000,
  startTimeoutMs: 60_000,
  pollIntervalMs: 2_000,
};

/** States in which a machine keeps its memory and disk and a resume brings it back. */
const PRESERVED_STATUSES: ReadonlySet<string> = new Set(["hibernated", "stopped"]);

const PROXY_NAMES = {
  codeServer: "code",
  terminal: "term",
  vnc: "vnc",
} as const;

export interface BoxdProviderConfig {
  scmProvider: SourceControlProviderName;
  /** Secret used for domain-separated sandbox access password derivation. */
  sandboxAccessPasswordSecret: string;
  /** Snapshot every session machine is created from (built by boxd-infra). */
  baseSnapshot: string;
  /** Prefix of every machine name; distinct per deployment sharing an org. */
  machinePrefix: string;
  /** Labels machines; distinct per deployment. */
  deploymentName: string;
}

type AccessKind = "codeServer" | "terminal" | "vnc" | "tunnel";

interface ProxyRequest {
  kind: AccessKind;
  name: string;
  port: number;
}

interface BoxdAccess {
  codeServerUrl?: string;
  codeServerPassword?: string;
  ttydUrl?: string;
  vncAccess?: VncAccess;
  tunnelUrls?: Record<string, string>;
}

/** Validate a machine name prefix (BOXD_MACHINE_PREFIX). */
export function isBoxdMachinePrefix(value: string): boolean {
  return BOXD_MACHINE_PREFIX_PATTERN.test(value);
}

/**
 * Deterministic machine name for one generation of a sandbox, so a create
 * retried after a lost answer finds the machine the first attempt made, while
 * a later generation of the same sandbox gets a machine of its own.
 */
export async function boxdMachineName(
  prefix: string,
  sandboxId: string,
  generationCreatedAtMs: number | undefined
): Promise<string> {
  const identity = `${sandboxId}:${generationCreatedAtMs ?? ""}`;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(identity));
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0"));
  return `${prefix}-${hex.join("").slice(0, MACHINE_NAME_HASH_CHARS)}`;
}

function noLifetime(): SandboxLifetime {
  return { kind: "none", observedAtMs: Date.now() };
}

export class BoxdSandboxProvider implements SandboxProvider {
  readonly name = "boxd";

  readonly capabilities: SandboxProviderCapabilities = {
    supportsSandboxTimeout: supportsConfigurableSandboxTimeout(this.name),
    supportsSnapshots: false,
    supportsRestore: false,
    // Stop hibernates and resume wakes the same machine with its processes.
    supportsPersistentResume: true,
    supportsExplicitStop: true,
  };

  private readonly timings: BoxdProviderTimings;

  constructor(
    private readonly api: BoxdSandboxApi,
    private readonly providerConfig: BoxdProviderConfig,
    timings: Partial<BoxdProviderTimings> = {},
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms)),
    private readonly now: () => number = Date.now
  ) {
    this.timings = { ...DEFAULT_BOXD_TIMINGS, ...timings };
  }

  async createSandbox(config: CreateSandboxConfig): Promise<CreateSandboxResult> {
    let machineId: string | undefined;
    try {
      const portPlan = resolvePortPlan(config);
      const proxies = proxyRequests(portPlan);
      const { envVars, codeServerPassword, vncPassword } = await this.buildRuntimeEnv(
        config,
        portPlan
      );

      const machine = await this.createOrAdopt(config, proxies);
      machineId = machine.id;
      await this.api.waitUntilReady(machineId, BOXD_READY_TIMEOUT_MS);

      const access = await this.resolveAccess(machineId, config.sandboxId, proxies, {
        codeServerPassword,
        vncPassword,
      });
      if (access.tunnelUrls) {
        await this.api.writeFile(
          machineId,
          BOXD_TUNNEL_INBOX_PATH,
          renderTunnelEnvFile(config.sandboxId, access.tunnelUrls),
          PRIVATE_FILE_MODE
        );
      }
      await this.api.writeFile(
        machineId,
        BOXD_SESSION_INBOX_PATH,
        JSON.stringify({ sandboxId: config.sandboxId, env: envVars }),
        PRIVATE_FILE_MODE
      );
      await this.accept(machineId);

      log.info("boxd.machine_created", {
        session_id: config.sessionId,
        sandbox_id: config.sandboxId,
        machine_id: machineId,
      });
      return {
        sandboxId: config.sandboxId,
        providerObjectId: machineId,
        createdAt: Date.now(),
        lifetime: noLifetime(),
        ...access,
      };
    } catch (error) {
      // A machine that exists but could not be handed its session would run
      // with nothing to do; delete it, then let the create fail loudly. One
      // that cannot be deleted is handed to the manager as a cleanup
      // obligation, so it is not forgotten.
      if (machineId && !(await this.deleteQuietly(machineId, config.sandboxId))) {
        throw new SandboxLaunchRejectedError(
          `Failed to create boxd sandbox, and its machine could not be deleted: ${errorMessage(error)}`,
          machineId,
          error instanceof Error ? error : undefined
        );
      }
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
      let machine: BoxdMachine;
      try {
        machine = await this.api.getMachine(config.providerObjectId);
      } catch (error) {
        if (isNotFound(error)) return spawnFresh("Sandbox no longer exists in boxd");
        throw error;
      }

      switch (machine.status) {
        case "failed":
        case "destroyed":
          return spawnFresh(`boxd machine is ${machine.status}`);
        case "hibernated":
          await this.api.wake(machine.id);
          break;
        case "suspended":
          await this.api.resume(machine.id);
          break;
        case "stopped":
          await this.api.start(machine.id);
          // boxd answers the start before the machine leaves `stopped`, and
          // the readiness wait treats `stopped` as final.
          await this.waitWhileStatus(machine.id, "stopped");
          break;
        default:
          // pending, starting, running, migrating: already on its way.
          break;
      }
      await this.api.waitUntilReady(machine.id, BOXD_READY_TIMEOUT_MS);
      // A woken machine still runs the runtime and this changes nothing; a
      // machine that booted again has started it from the kept environment.
      await this.accept(machine.id);

      const portPlan = resolvePortPlan(config);
      const access = await this.resolveAccess(
        machine.id,
        config.sandboxId,
        proxyRequests(portPlan),
        {
          codeServerPassword: config.codeServerEnabled
            ? await deriveCodeServerPassword(
                config.sandboxId,
                this.providerConfig.sandboxAccessPasswordSecret
              )
            : undefined,
          vncPassword: config.vncEnabled
            ? await deriveVncPassword(
                config.sandboxId,
                this.providerConfig.sandboxAccessPasswordSecret
              )
            : undefined,
        }
      );
      return {
        success: true,
        providerObjectId: machine.id,
        lifetime: noLifetime(),
        ...access,
      };
    } catch (error) {
      if (isNotFound(error)) return spawnFresh("Sandbox no longer exists in boxd");
      throw classifyBoxdError("Failed to resume boxd sandbox", error);
    }
  }

  /**
   * Idle and heartbeat stops hibernate the machine, and resumeSandbox wakes
   * it. boxd answers the hibernate request before the machine's memory is
   * written out, so the stop is confirmed only once a read reports the machine
   * hibernated. Terminal stops delete it: nothing will resume it.
   */
  async stopSandbox(config: StopConfig): Promise<StopResult> {
    throwIfCancelled(config.signal, config.deadlineAtMs, this.now());
    try {
      if (config.intent === "destroy") {
        try {
          await this.api.deleteMachine(config.providerObjectId);
        } catch (error) {
          if (isNotFound(error)) return { success: true };
          throw error;
        }
        return { success: true };
      }
      return await this.hibernate(config);
    } catch (error) {
      if (isNotFound(error)) {
        return {
          success: false,
          error: "Sandbox disappeared before graceful shutdown was verified",
        };
      }
      throw classifyBoxdError(
        `Failed to ${config.intent === "destroy" ? "delete" : "hibernate"} boxd sandbox`,
        error
      );
    }
  }

  private async hibernate(config: StopConfig): Promise<StopResult> {
    const deadlineAtMs = config.deadlineAtMs ?? this.now() + this.timings.hibernateTimeoutMs;
    let machine = await this.api.getMachine(config.providerObjectId);
    if (PRESERVED_STATUSES.has(machine.status)) return { success: true };
    try {
      await this.api.hibernate(config.providerObjectId);
    } catch (error) {
      // A stop retried while an earlier hibernate is still being written
      // finds the machine mid-change: wait for that one instead.
      if (!(error instanceof BoxdApiError) || error.kind !== "conflict") throw error;
    }
    for (;;) {
      machine = await this.api.getMachine(config.providerObjectId);
      if (PRESERVED_STATUSES.has(machine.status)) return { success: true };
      if (machine.status === "failed" || machine.status === "destroyed") {
        return { success: false, error: `boxd machine is ${machine.status}` };
      }
      if (config.signal?.aborted || this.now() + this.timings.pollIntervalMs > deadlineAtMs) {
        return {
          success: false,
          error: `Timed out before boxd confirmed the machine was hibernated (last ${machine.status})`,
        };
      }
      await this.sleep(this.timings.pollIntervalMs);
    }
  }

  /** Poll until the machine leaves `status`, within the start budget. */
  private async waitWhileStatus(machineId: string, status: string): Promise<void> {
    const deadlineAtMs = this.now() + this.timings.startTimeoutMs;
    while ((await this.api.getMachine(machineId)).status === status) {
      if (this.now() + this.timings.pollIntervalMs > deadlineAtMs) {
        throw new SandboxProviderError(`boxd machine is still ${status} after start`, "transient");
      }
      await this.sleep(this.timings.pollIntervalMs);
    }
  }

  /**
   * Create the session's machine. Its name is derived from the sandbox id, so
   * a create whose answer was lost and is retried finds the machine the first
   * attempt made (boxd answers the name with a conflict) and adopts it.
   */
  private async createOrAdopt(
    config: CreateSandboxConfig,
    proxies: ProxyRequest[]
  ): Promise<BoxdMachine> {
    const name = await boxdMachineName(
      this.providerConfig.machinePrefix,
      config.sandboxId,
      config.generationCreatedAtMs
    );
    try {
      return await this.api.createMachine({
        name,
        fromSnapshot: this.providerConfig.baseSnapshot,
        labels: {
          [BOXD_DEPLOYMENT_LABEL]: this.providerConfig.deploymentName,
          [BOXD_SESSION_LABEL]: config.sessionId,
          [BOXD_SANDBOX_LABEL]: config.sandboxId,
        },
        proxies: proxies.map(({ name: proxyName, port }) => ({ name: proxyName, port })),
      });
    } catch (error) {
      // A conflict on the name means an earlier attempt for this generation
      // made the machine. A failure with no answer (a lost response, a
      // timeout) may have made it too: look the name up either way.
      if (!(error instanceof BoxdApiError) || (error.kind !== "conflict" && !error.isRetryable)) {
        throw error;
      }
      let existing: BoxdMachine;
      try {
        existing = await this.api.getMachine(name);
      } catch (lookupError) {
        // Nothing of that name: the create's own error is the answer.
        if (isNotFound(lookupError)) throw error;
        throw lookupError;
      }
      if (existing.labels[BOXD_SANDBOX_LABEL] !== config.sandboxId) {
        throw new SandboxProviderError(
          `boxd machine ${name} already exists and belongs to another sandbox`,
          "permanent",
          error
        );
      }
      log.info("boxd.machine_adopted", { sandbox_id: config.sandboxId, machine_id: existing.id });
      return existing;
    }
  }

  /** Hand the written session to the machine and start the runtime service. */
  private async accept(machineId: string): Promise<void> {
    const result = await this.api.exec(machineId, BOXD_ACCEPT_COMMAND, ACCEPT_TIMEOUT_MS);
    if (result.exitCode !== 0) {
      // The launcher prints a reason and never a value from the environment.
      throw new SandboxProviderError(
        `boxd sandbox launcher exited ${result.exitCode}: ${result.stderr.trim().slice(-500)}`,
        "permanent"
      );
    }
  }

  /** Delete a machine the create gave up on; false when it may still exist. */
  private async deleteQuietly(machineId: string, sandboxId: string): Promise<boolean> {
    try {
      await this.api.deleteMachine(machineId);
      return true;
    } catch (error) {
      if (isNotFound(error)) return true;
      log.warn("boxd.create_cleanup_failed", {
        sandbox_id: sandboxId,
        machine_id: machineId,
        error: errorMessage(error),
      });
      return false;
    }
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
      emitDisabledTerminalEnv: true,
    });
    // Every boot marker is stated, never merely omitted, so a repo secret of
    // the same name cannot decide how the runtime boots. The launcher sets
    // RESTORED_FROM_SNAPSHOT itself on a boot after the first.
    Object.assign(envVars, {
      [DEFERRED_START_ENV_VAR]: "false",
      [IMAGE_BUILD_MODE_ENV_VAR]: "false",
      RESTORED_FROM_SNAPSHOT: "false",
      FROM_REPO_IMAGE: "false",
      SANDBOX_VERSION: BOXD_SANDBOX_VERSION,
    });
    if (portPlan.extraTunnelPorts.length > 0) {
      envVars[EXPECTED_TUNNEL_PORTS_ENV_VAR] = portPlan.extraTunnelPorts.join(",");
    }
    return { envVars, codeServerPassword, vncPassword };
  }

  /**
   * The URLs of the session's proxies. Access links are extras, not how a
   * session runs: a lookup that fails is logged and the session runs without
   * them.
   */
  private async resolveAccess(
    machineId: string,
    sandboxId: string,
    requests: ProxyRequest[],
    passwords: { codeServerPassword?: string; vncPassword?: string }
  ): Promise<BoxdAccess> {
    if (requests.length === 0) return {};
    let domains: Record<string, string>;
    try {
      domains = await this.api.proxyDomains(machineId);
    } catch (error) {
      // A machine that is gone is not a missing link: the caller decides.
      if (isNotFound(error)) throw error;
      log.warn("boxd.proxy_lookup_failed", {
        sandbox_id: sandboxId,
        error: error instanceof Error ? error.message : String(error),
      });
      return {};
    }

    const access: BoxdAccess = {};
    const tunnelUrls: Record<string, string> = {};
    for (const request of requests) {
      const domain = domains[request.name];
      if (!domain) {
        log.warn("boxd.proxy_missing", {
          sandbox_id: sandboxId,
          access_kind: request.kind,
          port: request.port,
        });
        continue;
      }
      const url = `https://${domain}`;
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
    if (Object.keys(tunnelUrls).length > 0) access.tunnelUrls = tunnelUrls;
    return access;
  }
}

function resolvePortPlan(
  config: Pick<CreateSandboxConfig, "codeServerEnabled" | "vncEnabled" | "sandboxSettings">
): SandboxPortPlan {
  return resolveSandboxPortPlan(
    {
      codeServer: config.codeServerEnabled === true,
      terminal: config.sandboxSettings?.terminalEnabled === true,
      vnc: config.vncEnabled === true,
    },
    config.sandboxSettings
  );
}

/** One named proxy per enabled service and per user tunnel port. */
function proxyRequests(portPlan: SandboxPortPlan): ProxyRequest[] {
  const requests: ProxyRequest[] = [];
  if (portPlan.codeServerPort !== undefined) {
    requests.push({
      kind: "codeServer",
      name: PROXY_NAMES.codeServer,
      port: portPlan.codeServerPort,
    });
  }
  if (portPlan.terminalPort !== undefined) {
    requests.push({ kind: "terminal", name: PROXY_NAMES.terminal, port: portPlan.terminalPort });
  }
  if (portPlan.vncPort !== undefined) {
    requests.push({ kind: "vnc", name: PROXY_NAMES.vnc, port: portPlan.vncPort });
  }
  for (const port of portPlan.extraTunnelPorts) {
    requests.push({ kind: "tunnel", name: `port-${port}`, port });
  }
  return requests;
}

function renderTunnelEnvFile(sandboxId: string, tunnelUrls: Record<string, string>): string {
  const lines = [
    `${TUNNEL_ENV_SANDBOX_ID_KEY}=${sandboxId}`,
    ...Object.entries(tunnelUrls)
      .sort(([a], [b]) => Number(a) - Number(b))
      .map(([port, url]) => `TUNNEL_${port}=${url}`),
  ];
  return lines.join("\n") + "\n";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isNotFound(error: unknown): boolean {
  return error instanceof BoxdApiError && error.kind === "not_found";
}

function throwIfCancelled(
  signal: AbortSignal | undefined,
  deadlineAtMs: number | undefined,
  nowMs: number
): void {
  if (signal?.aborted) {
    throw new SandboxProviderError("boxd stop was cancelled", "transient");
  }
  if (deadlineAtMs !== undefined && nowMs >= deadlineAtMs) {
    throw new SandboxProviderError("boxd stop deadline exceeded", "transient");
  }
}

function classifyBoxdError(message: string, error: unknown): SandboxProviderError {
  if (error instanceof SandboxProviderError) return error;
  if (error instanceof BoxdApiError) {
    return new SandboxProviderError(
      `${message}: ${error.message}`,
      error.isRetryable ? "transient" : "permanent",
      error
    );
  }
  return SandboxProviderError.fromFetchError(`${message}: ${String(error)}`, error);
}

export function createBoxdProvider(
  api: BoxdSandboxApi,
  providerConfig: BoxdProviderConfig
): BoxdSandboxProvider {
  return new BoxdSandboxProvider(api, providerConfig);
}
