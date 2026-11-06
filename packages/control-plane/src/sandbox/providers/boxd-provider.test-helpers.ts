import { expect, vi } from "vitest";
import {
  BoxdSandboxProvider,
  BOXD_LAUNCHER_EXIT_PATH,
  BOXD_SESSION_ENV_FILE_PATH,
  type BoxdLifecycleTimings,
  type BoxdProviderConfig,
} from "./boxd-provider";
import type { BoxdClient, BoxdExecResult, BoxdMachine, BoxdProxy } from "../boxd-client";

export const providerConfig: BoxdProviderConfig = {
  scmProvider: "github",
  sandboxAccessPasswordSecret: "secret",
  baseSnapshot: "open-inspect-abc123",
  defaultSize: "2x8",
  deploymentName: "test",
};

export const MACHINE_ID = "4f1c2b8e-0000-4000-8000-00000000abcd";

export function boxdMachine(overrides: Partial<BoxdMachine> = {}): BoxdMachine {
  return {
    id: MACHINE_ID,
    name: "oi-test-0123456789abcdef",
    status: "running",
    vcpu: 2,
    memoryBytes: 8 * 1024 ** 3,
    shared: false,
    labels: {},
    ...overrides,
  };
}

function ok(stdout = ""): BoxdExecResult {
  return { exitCode: 0, stdout, stderr: "" };
}

/**
 * An exec fake that answers the provider's commands: the readiness probe, the
 * launch, and the launcher-exit read (empty: still running) unless overridden.
 */
export function execAnswering(
  answers: { launcherExit?: string; launch?: BoxdExecResult; logTail?: string } = {}
) {
  return vi.fn(async (_id: string, command: string): Promise<BoxdExecResult> => {
    if (command.startsWith("cat ") && command.includes(BOXD_LAUNCHER_EXIT_PATH)) {
      return ok(answers.launcherExit ?? "");
    }
    if (command.startsWith("tail ")) return ok(answers.logTail ?? "");
    if (command.includes("setsid")) return answers.launch ?? ok();
    return ok();
  });
}

/** A proxy store the way boxd keeps one: the default route plus every named route created. */
export function proxyStore(domain = "oi-test-0123456789abcdef.boxd.sh") {
  const proxies: BoxdProxy[] = [{ name: null, domain, port: 8000 }];
  return {
    proxies,
    listProxies: vi.fn(async () => proxies.map((proxy) => ({ ...proxy }))),
    createProxy: vi.fn(async (_id: string, name: string, port: number) => {
      proxies.push({ name, domain: `${name}.${domain}`, port });
    }),
  };
}

export function mockClient(overrides: Partial<BoxdClient> = {}): BoxdClient {
  const store = proxyStore();
  return {
    config: { apiKey: "secret" },
    createFromSnapshot: vi.fn(async () => boxdMachine()),
    getMachine: vi.fn(async () => boxdMachine()),
    deleteMachine: vi.fn(async () => {}),
    startMachine: vi.fn(async () => {}),
    hibernateMachine: vi.fn(async () => {}),
    wakeMachine: vi.fn(async () => {}),
    unshareMachine: vi.fn(async () => {}),
    resizeMachine: vi.fn(async () => {}),
    exec: execAnswering(),
    writeFile: vi.fn(async () => {}),
    listProxies: store.listProxies,
    createProxy: store.createProxy,
    ...overrides,
  } as unknown as BoxdClient;
}

/** The session env file the provider wrote on create. */
export function sessionEnvFile(client: BoxdClient): string {
  const call = vi
    .mocked(client.writeFile)
    .mock.calls.find(([, file]) => file.path === BOXD_SESSION_ENV_FILE_PATH);
  expect(call).toBeDefined();
  return call![1].content;
}

/** The session env as the launcher would see it after sourcing the file. */
export function sessionEnv(client: BoxdClient): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of sessionEnvFile(client).split("\n")) {
    const match = /^export ([A-Za-z_][A-Za-z0-9_]*)='(.*)'$/.exec(line);
    if (match) env[match[1]] = match[2].replace(/'\\''/g, "'");
  }
  return env;
}

export const baseCreateConfig = {
  sessionId: "sess-1",
  sandboxId: "sandbox-logical",
  repoOwner: "o",
  repoName: "r",
  controlPlaneUrl: "https://cp.test",
  sandboxAuthToken: "tok",
  harness: "opencode" as const,
  provider: "anthropic",
  model: "claude",
  codeServerEnabled: true,
};

/** Polling intervals shrunk so the provider's waits complete within a unit test. */
export const fastTimings: BoxdLifecycleTimings = {
  pollIntervalMs: 1,
  readyPollIntervalMs: 1,
  readyTimeoutMs: 200,
  stopTimeoutMs: 200,
  hibernateRetryMs: 5,
  suspendedGraceMs: 20,
  launchSettleMs: 5,
  launchPollIntervalMs: 1,
  createRetryDelayMs: 1,
};

export function createProvider(
  client: BoxdClient,
  config: BoxdProviderConfig = providerConfig
): BoxdSandboxProvider {
  return new BoxdSandboxProvider(client, config, fastTimings);
}
