/**
 * Client for the boxd machine API.
 *
 * boxd's public API is gRPC; the `@boxd-sh/sdk/web` entry speaks it as
 * grpc-web over `fetch`, with no Node built-ins, so it runs in the Worker and
 * in the Node host alike. This module is the only place that touches the SDK:
 * it narrows it to the calls the control plane makes, runs each one under a
 * per-operation deadline, and turns the SDK's errors into typed errors that
 * carry the gRPC status code, so callers classify failures by code rather than
 * by message text. The SDK is imported lazily on first use, so a deployment
 * that runs another provider never evaluates it.
 *
 * Wire-level behaviour verified against the SDK source (`machines.ts`,
 * `fs.ts`, `proxies.ts`, `errors.ts`) at @boxd-sh/sdk 0.3.0.
 */

import { createLogger } from "../logger";
import { RequestDeadlineError, withRequestDeadline } from "./request-deadline";
import { scrubEnvValues } from "./scrub-env-values";

const log = createLogger("boxd-client");

/** boxd machine sizes, smallest first: `<vCPU>x<GiB>`. */
export const BOXD_MACHINE_SIZES = ["1x4", "2x8", "4x16", "8x32"] as const;
export type BoxdMachineSize = (typeof BOXD_MACHINE_SIZES)[number];

export function isBoxdMachineSize(value: string): value is BoxdMachineSize {
  return (BOXD_MACHINE_SIZES as readonly string[]).includes(value);
}

/** vCPU and memory of a size, as the API takes them. */
export function boxdSizeResources(size: BoxdMachineSize): { vcpu: number; memoryGib: number } {
  const [vcpu, memoryGib] = size.split("x").map(Number);
  return { vcpu, memoryGib };
}

/**
 * Machine statuses the API reports. `get` is the source of truth; a status
 * boxd adds later is passed through as a plain string and treated as "not one
 * we know" by callers.
 */
export const BOXD_MACHINE_STATUSES = [
  "pending",
  "starting",
  "running",
  "suspended",
  "hibernated",
  "stopped",
  "failed",
  "destroyed",
  "migrating",
] as const;

export interface BoxdClientConfig {
  apiKey: string;
  /** Region machines are created and looked up in (`fra`, `nyc`, ...); the key's home region when omitted. */
  region?: string;
  /** Org the machines are created in and billed to; the key's own org (or personal) when omitted. */
  org?: string;
  /** API endpoint; production when omitted. Only for a non-production boxd cluster. */
  baseUrl?: string;
}

/** The subset of a boxd machine the control plane acts on. */
export interface BoxdMachine {
  id: string;
  name: string;
  status: string;
  vcpu: number;
  memoryBytes: number;
  /** Whether every member of the machine's org can reach it (SSH, exec, files). */
  shared: boolean;
  labels: Record<string, string>;
}

export interface BoxdExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** One HTTPS route into a machine: `https://<domain>` forwards to `port` inside it. */
export interface BoxdProxy {
  /** `null` for the machine's default route. */
  name: string | null;
  domain: string;
  port: number;
}

export interface BoxdCreateFromSnapshotParams {
  snapshot: string;
  /** Machine name: unique across boxd, so a repeat of the same create is refused rather than duplicated. */
  name: string;
  labels: Record<string, string>;
}

// gRPC status codes the classification below names.
export const BOXD_GRPC_STATUS = {
  CANCELLED: 1,
  UNKNOWN: 2,
  INVALID_ARGUMENT: 3,
  DEADLINE_EXCEEDED: 4,
  NOT_FOUND: 5,
  ALREADY_EXISTS: 6,
  PERMISSION_DENIED: 7,
  RESOURCE_EXHAUSTED: 8,
  FAILED_PRECONDITION: 9,
  ABORTED: 10,
  INTERNAL: 13,
  UNAVAILABLE: 14,
  UNAUTHENTICATED: 16,
} as const;

/** Codes that say "try again": boxd's moment, not a wrong request. */
const TRANSIENT_GRPC_CODES: ReadonlySet<number> = new Set([
  BOXD_GRPC_STATUS.UNKNOWN,
  BOXD_GRPC_STATUS.DEADLINE_EXCEEDED,
  BOXD_GRPC_STATUS.RESOURCE_EXHAUSTED,
  BOXD_GRPC_STATUS.ABORTED,
  BOXD_GRPC_STATUS.INTERNAL,
  BOXD_GRPC_STATUS.UNAVAILABLE,
]);

/** Longest provider message carried into a control-plane error. */
const MAX_ERROR_MESSAGE_CHARS = 300;

const TIMEOUT_CREATE_MS = 60_000;
const TIMEOUT_GET_MS = 15_000;
const TIMEOUT_LIFECYCLE_MS = 60_000;
const TIMEOUT_RESIZE_MS = 60_000;
const TIMEOUT_DELETE_MS = 30_000;
const TIMEOUT_SHARE_MS = 15_000;
const TIMEOUT_WRITE_FILE_MS = 30_000;
const TIMEOUT_PROXY_MS = 15_000;
/** Headroom over a command's own timeout for transport and queueing. */
const EXEC_TRANSPORT_HEADROOM_MS = 15_000;

export class BoxdApiError extends Error {
  constructor(
    message: string,
    /** gRPC status code; undefined when boxd could not be reached at all. */
    public readonly grpcCode: number | undefined,
    /** boxd's machine-readable reason, when it named one (`invalid_token`, ...). */
    public readonly reason?: string
  ) {
    super(message);
    this.name = "BoxdApiError";
  }

  /** Whether repeating the call later can succeed (rate limit, boxd unavailable, lost connection). */
  get transient(): boolean {
    return this.grpcCode === undefined || TRANSIENT_GRPC_CODES.has(this.grpcCode);
  }
}

/** boxd answered NOT_FOUND: the machine (or snapshot) no longer exists, or never did. */
export class BoxdNotFoundError extends BoxdApiError {
  constructor(message: string, reason?: string) {
    super(message, BOXD_GRPC_STATUS.NOT_FOUND, reason);
    this.name = "BoxdNotFoundError";
  }
}

/** boxd answered ALREADY_EXISTS (a machine name is taken) or FAILED_PRECONDITION (wrong state). */
export class BoxdConflictError extends BoxdApiError {
  constructor(message: string, grpcCode: number, reason?: string) {
    super(message, grpcCode, reason);
    this.name = "BoxdConflictError";
  }
}

/** The caller's own signal ended the operation before boxd answered. */
export class BoxdCancelledError extends Error {
  constructor(operation: string) {
    super(`boxd operation cancelled before it completed (${operation})`);
    this.name = "BoxdCancelledError";
  }
}

/** Resolve after `delayMs`, or reject with BoxdCancelledError when `signal` aborts first. */
export function delayUnlessCancelled(delayMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new BoxdCancelledError("delay"));
      return;
    }
    const timeoutId = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timeoutId);
      reject(new BoxdCancelledError("delay"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * The SDK surface this client uses: a structural subset of `Boxd` from
 * `@boxd-sh/sdk/web`, so tests can stand a fake in for it.
 */
export interface BoxdSdk {
  machines: {
    create(params: {
      fromSnapshot: string;
      name: string;
      org?: string;
      isolated: boolean;
      labels: Record<string, string>;
    }): Promise<BoxdSdkMachine>;
    get(id: string): Promise<BoxdSdkMachine>;
    delete(id: string): Promise<void>;
    start(id: string): Promise<void>;
    hibernate(id: string): Promise<void>;
    wake(id: string): Promise<void>;
    unshare(id: string): Promise<void>;
    resize(id: string, params: { vcpu: number }): Promise<unknown>;
    exec(
      id: string,
      params: { command: string; timeout?: number }
    ): Promise<{ exitCode: number; stdout: string; stderr: string }>;
    fs: {
      write(id: string, path: string, data: string, opts?: { mode?: number }): Promise<unknown>;
    };
    proxies: {
      create(machine: string, name: string, port: number): Promise<unknown>;
      list(machine: string): Promise<Array<{ name: string | null; domain: string; port: number }>>;
    };
  };
}

/** The fields of the SDK's `Machine` model the client reads. */
export interface BoxdSdkMachine {
  id: string;
  name: string;
  status: string;
  resources: { vcpu: number; memoryBytes: number };
  shared: boolean;
  labels: Record<string, string>;
}

/** Build the SDK client. Imported on first use, so other providers' deployments never load it. */
async function loadBoxdSdk(config: BoxdClientConfig): Promise<BoxdSdk> {
  const { Boxd } = await import("@boxd-sh/sdk/web");
  return new Boxd({
    apiKey: config.apiKey,
    ...(config.region ? { region: config.region } : {}),
    ...(config.baseUrl ? { baseURL: config.baseUrl } : {}),
  }) as unknown as BoxdSdk;
}

function toMachine(machine: BoxdSdkMachine): BoxdMachine {
  return {
    id: machine.id,
    name: machine.name,
    status: machine.status,
    vcpu: machine.resources.vcpu,
    memoryBytes: machine.resources.memoryBytes,
    shared: machine.shared,
    labels: { ...machine.labels },
  };
}

interface CallOptions {
  signal?: AbortSignal;
  /** Runs over a provider error message before it is shortened and kept on the thrown error. */
  redact?: (message: string) => string;
}

export class BoxdClient {
  private sdk: Promise<BoxdSdk> | undefined;

  constructor(
    public readonly config: BoxdClientConfig,
    sdkFactory: (config: BoxdClientConfig) => Promise<BoxdSdk> = loadBoxdSdk
  ) {
    if (!config.apiKey) throw new Error("BoxdClient requires apiKey");
    this.sdkFactory = sdkFactory;
  }

  private readonly sdkFactory: (config: BoxdClientConfig) => Promise<BoxdSdk>;

  private loadSdk(): Promise<BoxdSdk> {
    // A failed load is not cached: the next call tries again.
    this.sdk ??= this.sdkFactory(this.config).catch((error: unknown) => {
      this.sdk = undefined;
      throw error;
    });
    return this.sdk;
  }

  /**
   * Restore a machine from a snapshot (memory and disk, so it comes up with
   * the snapshot's processes and size), private to the API key's owner, with
   * the given name and labels. Always isolated: no metadata endpoint, no
   * in-VM boxd CLI, none of the account's integrations or agent logins, so
   * code running in the machine cannot act as the API key's owner. The name is unique across boxd: a repeat of the
   * same create answers BoxdConflictError instead of a second machine.
   */
  async createFromSnapshot(
    params: BoxdCreateFromSnapshotParams,
    signal?: AbortSignal
  ): Promise<BoxdMachine> {
    const startMs = Date.now();
    try {
      return await this.call("createFromSnapshot", TIMEOUT_CREATE_MS, { signal }, async (sdk) =>
        toMachine(
          await sdk.machines.create({
            fromSnapshot: params.snapshot,
            name: params.name,
            isolated: true,
            labels: params.labels,
            ...(this.config.org ? { org: this.config.org } : {}),
          })
        )
      );
    } finally {
      log.info("boxd.create_machine", {
        duration_ms: Date.now() - startMs,
        from_snapshot: params.snapshot,
        machine_name: params.name,
      });
    }
  }

  async getMachine(id: string, signal?: AbortSignal): Promise<BoxdMachine> {
    return this.call("getMachine", TIMEOUT_GET_MS, { signal }, async (sdk) =>
      toMachine(await sdk.machines.get(id))
    );
  }

  /** Destroy the machine and its disk. Irreversible. */
  async deleteMachine(id: string, signal?: AbortSignal): Promise<void> {
    await this.call("deleteMachine", TIMEOUT_DELETE_MS, { signal }, (sdk) =>
      sdk.machines.delete(id)
    );
  }

  /** Cold-boot a stopped machine; its disk is kept, its memory is not. */
  async startMachine(id: string, signal?: AbortSignal): Promise<void> {
    await this.call("startMachine", TIMEOUT_LIFECYCLE_MS, { signal }, (sdk) =>
      sdk.machines.start(id)
    );
  }

  /** Save the machine's memory and disk and release its host. `wakeMachine` brings it back. */
  async hibernateMachine(id: string, signal?: AbortSignal): Promise<void> {
    await this.call("hibernateMachine", TIMEOUT_LIFECYCLE_MS, { signal }, (sdk) =>
      sdk.machines.hibernate(id)
    );
  }

  /** Bring a hibernated or suspended machine back, processes and all. */
  async wakeMachine(id: string, signal?: AbortSignal): Promise<void> {
    await this.call("wakeMachine", TIMEOUT_LIFECYCLE_MS, { signal }, (sdk) =>
      sdk.machines.wake(id)
    );
  }

  /** Make an org machine private to its creator, so other org members cannot reach it. */
  async unshareMachine(id: string, signal?: AbortSignal): Promise<void> {
    await this.call("unshareMachine", TIMEOUT_SHARE_MS, { signal }, (sdk) =>
      sdk.machines.unshare(id)
    );
  }

  /**
   * Move a machine to another size class. A running machine is rebooted to
   * apply it (cold boot: the disk survives, memory does not).
   */
  async resizeMachine(id: string, vcpu: number, signal?: AbortSignal): Promise<void> {
    await this.call("resizeMachine", TIMEOUT_RESIZE_MS, { signal }, async (sdk) => {
      await sdk.machines.resize(id, { vcpu });
    });
  }

  /**
   * Run `command` through the machine user's shell to completion. boxd kills
   * the command's process group when `timeoutSeconds` elapses. The command
   * line is kept free of secrets: the session env travels as a file.
   */
  async exec(
    id: string,
    command: string,
    options: { timeoutSeconds: number },
    signal?: AbortSignal
  ): Promise<BoxdExecResult> {
    const timeoutMs = options.timeoutSeconds * 1000;
    return this.call("exec", timeoutMs + EXEC_TRANSPORT_HEADROOM_MS, { signal }, async (sdk) => {
      const result = await sdk.machines.exec(id, { command, timeout: timeoutMs });
      return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
    });
  }

  /**
   * Write a UTF-8 file as the machine user, creating missing parent
   * directories. `mode` applies to the file whether or not it existed.
   * `secretValues` are scrubbed from any error the write produces, since the
   * content may carry them.
   */
  async writeFile(
    id: string,
    file: { path: string; content: string; mode?: number; secretValues?: Record<string, string> },
    signal?: AbortSignal
  ): Promise<void> {
    const secrets = file.secretValues;
    await this.call(
      "writeFile",
      TIMEOUT_WRITE_FILE_MS,
      {
        signal,
        redact: secrets ? (message) => scrubEnvValues(message, secrets) : undefined,
      },
      async (sdk) => {
        await sdk.machines.fs.write(
          id,
          file.path,
          file.content,
          file.mode !== undefined ? { mode: file.mode } : undefined
        );
      }
    );
  }

  /** The machine's HTTPS routes, its default one included. */
  async listProxies(id: string, signal?: AbortSignal): Promise<BoxdProxy[]> {
    return this.call("listProxies", TIMEOUT_PROXY_MS, { signal }, async (sdk) =>
      (await sdk.machines.proxies.list(id)).map((proxy) => ({
        name: proxy.name,
        domain: proxy.domain,
        port: proxy.port,
      }))
    );
  }

  /**
   * Add the route `https://<name>.<machine domain>` to `port`. Named routes
   * are never behind boxd's bot check, so non-browser clients reach them too.
   */
  async createProxy(id: string, name: string, port: number, signal?: AbortSignal): Promise<void> {
    await this.call("createProxy", TIMEOUT_PROXY_MS, { signal }, async (sdk) => {
      await sdk.machines.proxies.create(id, name, port);
    });
  }

  /**
   * Run one SDK call under `timeoutMs` (and the caller's signal). The SDK
   * takes no signal, so the deadline settles the call here and the request is
   * left to finish on its own. A deadline surfaces as RequestDeadlineError,
   * which the provider classifies transient; the caller's own abort as
   * BoxdCancelledError; anything the SDK throws as a BoxdApiError.
   */
  private async call<T>(
    operation: string,
    timeoutMs: number,
    options: CallOptions,
    run: (sdk: BoxdSdk) => Promise<T>
  ): Promise<T> {
    try {
      return await withRequestDeadline("boxd", operation, timeoutMs, options.signal, (signal) =>
        settleOnAbort(
          (async () => {
            const sdk = await this.loadSdk();
            try {
              return await run(sdk);
            } catch (error) {
              throw toApiError(operation, error, options.redact);
            }
          })(),
          signal
        )
      );
    } catch (error) {
      if (
        options.signal?.aborted &&
        !(error instanceof BoxdApiError) &&
        !(error instanceof RequestDeadlineError)
      ) {
        throw new BoxdCancelledError(operation);
      }
      throw error;
    }
  }
}

/** Reject with the signal's reason as soon as it aborts, whatever `promise` is still doing. */
function settleOnAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    promise.catch(() => {});
    return Promise.reject(signal.reason);
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      }
    );
  });
}

/**
 * Read an SDK error into a typed one. The SDK maps every gRPC failure to a
 * `BoxdError` subclass carrying `grpcCode` and, where boxd names one,
 * `reason`; a failure to reach boxd at all (`APIConnectionError`) carries no
 * code. `redact` sees the whole provider message before it is shortened, so a
 * value the message echoes cannot survive the cut in part.
 */
function toApiError(
  operation: string,
  error: unknown,
  redact: (message: string) => string = (message) => message
): Error {
  if (error instanceof BoxdApiError || error instanceof BoxdCancelledError) return error;
  const raw = error instanceof Error ? error.message : String(error);
  const fields = (error ?? {}) as { grpcCode?: unknown; reason?: unknown; name?: unknown };
  const grpcCode = typeof fields.grpcCode === "number" ? fields.grpcCode : undefined;
  const reason = typeof fields.reason === "string" ? fields.reason : undefined;
  const detail = raw ? `: ${redact(raw).slice(0, MAX_ERROR_MESSAGE_CHARS)}` : "";
  const label =
    grpcCode !== undefined
      ? `gRPC ${grpcCode}${reason ? ` (${reason})` : ""}`
      : String(fields.name ?? "error");
  const summary = `boxd ${operation} failed with ${label}${detail}`;
  if (grpcCode === BOXD_GRPC_STATUS.NOT_FOUND) return new BoxdNotFoundError(summary, reason);
  if (
    grpcCode === BOXD_GRPC_STATUS.ALREADY_EXISTS ||
    grpcCode === BOXD_GRPC_STATUS.FAILED_PRECONDITION
  ) {
    return new BoxdConflictError(summary, grpcCode, reason);
  }
  return new BoxdApiError(summary, grpcCode, reason);
}

export function createBoxdClient(config: BoxdClientConfig): BoxdClient {
  return new BoxdClient(config);
}
