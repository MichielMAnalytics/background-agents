import { describe, expect, it, vi } from "vitest";
import {
  BoxdApiError,
  type BoxdCreateMachineRequest,
  type BoxdMachine,
  type BoxdMachineStatus,
  type BoxdSandboxApi,
} from "../boxd-api";
import {
  SandboxLaunchRejectedError,
  SandboxProviderError,
  type CreateSandboxConfig,
  type ResumeConfig,
} from "../provider";
import { deriveCodeServerPassword } from "../sandbox-env";
import {
  BOXD_ACCEPT_COMMAND,
  BOXD_DEPLOYMENT_LABEL,
  BOXD_SANDBOX_VERSION,
  BOXD_SANDBOX_LABEL,
  BOXD_SESSION_INBOX_PATH,
  BOXD_SESSION_LABEL,
  BOXD_TUNNEL_INBOX_PATH,
  BoxdSandboxProvider,
  boxdMachineName,
} from "./boxd-provider";

const MACHINE_ID = "machine-1";
const SECRET = "test-api-key";

function machine(status: BoxdMachineStatus, overrides: Partial<BoxdMachine> = {}): BoxdMachine {
  return { id: MACHINE_ID, name: "openinspect-abc", status, labels: {}, ...overrides };
}

function fakeApi(statuses: Array<BoxdMachineStatus | null> = ["running"]) {
  const queue = [...statuses];
  const files: Array<{ path: string; content: string; mode: number }> = [];
  const api = {
    createMachine: vi.fn(async (request: BoxdCreateMachineRequest) =>
      machine("pending", { name: request.name, labels: request.labels })
    ),
    getMachine: vi.fn(async (_idOrName: string) => {
      const status = queue.length > 1 ? queue.shift()! : queue[0];
      if (status === null) throw new BoxdApiError("machine not found", "not_found");
      return machine(status);
    }),
    waitUntilReady: vi.fn(async () => machine("running")),
    writeFile: vi.fn(async (_id: string, path: string, content: string, mode: number) => {
      files.push({ path, content, mode });
    }),
    exec: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
    hibernate: vi.fn(async () => {}),
    wake: vi.fn(async () => {}),
    resume: vi.fn(async () => {}),
    start: vi.fn(async () => {}),
    deleteMachine: vi.fn(async () => {}),
    proxyDomains: vi.fn(async (): Promise<Record<string, string>> => ({})),
  } satisfies BoxdSandboxApi;
  return { api, files };
}

let clockMs = 1_800_000_000_000;
const sleep = vi.fn(async (ms: number) => {
  clockMs += ms;
});

function createProvider(api: BoxdSandboxApi) {
  return new BoxdSandboxProvider(
    api,
    {
      scmProvider: "github",
      sandboxAccessPasswordSecret: SECRET,
      baseSnapshot: "openinspect-sandbox-0123456789abcdef",
      machinePrefix: "openinspect",
      deploymentName: "test-deployment",
    },
    { pollIntervalMs: 2_000, hibernateTimeoutMs: 10_000, startTimeoutMs: 10_000 },
    sleep,
    () => clockMs
  );
}

const createConfig: CreateSandboxConfig = {
  sessionId: "session-1",
  sandboxId: "sandbox-acme-web-app-1700000000000",
  repoOwner: "acme",
  repoName: "web-app",
  controlPlaneUrl: "https://control.example.com",
  sandboxAuthToken: "sandbox-auth-secret",
  harness: "opencode",
  provider: "anthropic",
  model: "claude-sonnet-4-5",
  userEnvVars: { MY_SECRET: "repo-secret", RESTORED_FROM_SNAPSHOT: "true" },
  generationCreatedAtMs: 1_700_000_000_000,
};

const resumeConfig: ResumeConfig = {
  providerObjectId: MACHINE_ID,
  sessionId: "session-1",
  sandboxId: createConfig.sandboxId,
};

function sessionFile(files: Array<{ path: string; content: string; mode: number }>) {
  const file = files.find(({ path }) => path === BOXD_SESSION_INBOX_PATH);
  expect(file).toBeDefined();
  return {
    ...file!,
    parsed: JSON.parse(file!.content) as { sandboxId: string; env: Record<string, string> },
  };
}

describe("BoxdSandboxProvider.createSandbox", () => {
  it("creates the machine from the base snapshot and hands it the session through the inbox", async () => {
    const { api, files } = fakeApi();

    const result = await createProvider(api).createSandbox(createConfig);

    const name = await boxdMachineName(
      "openinspect",
      createConfig.sandboxId,
      createConfig.generationCreatedAtMs
    );
    expect(name).toMatch(/^openinspect-[0-9a-f]{16}$/);
    expect(api.createMachine).toHaveBeenCalledWith({
      name,
      fromSnapshot: "openinspect-sandbox-0123456789abcdef",
      labels: {
        [BOXD_DEPLOYMENT_LABEL]: "test-deployment",
        [BOXD_SESSION_LABEL]: "session-1",
        [BOXD_SANDBOX_LABEL]: createConfig.sandboxId,
      },
      proxies: [],
    });
    expect(api.waitUntilReady).toHaveBeenCalledWith(MACHINE_ID, expect.any(Number));

    const session = sessionFile(files);
    expect(session.mode).toBe(0o600);
    expect(session.parsed.sandboxId).toBe(createConfig.sandboxId);
    expect(session.parsed.env).toMatchObject({
      SANDBOX_ID: createConfig.sandboxId,
      SANDBOX_AUTH_TOKEN: "sandbox-auth-secret",
      CONTROL_PLANE_URL: "https://control.example.com",
      MY_SECRET: "repo-secret",
      // A repo secret cannot claim a boot mode.
      RESTORED_FROM_SNAPSHOT: "false",
      FROM_REPO_IMAGE: "false",
      IMAGE_BUILD_MODE: "false",
      // Reported back, so a resumed sandbox keeps the confirmed-shutdown protocol.
      SANDBOX_VERSION: BOXD_SANDBOX_VERSION,
    });

    // The session is written before the launcher is asked to take it.
    expect(api.writeFile.mock.invocationCallOrder[0]).toBeLessThan(
      api.exec.mock.invocationCallOrder[0]
    );
    expect(api.exec).toHaveBeenCalledWith(MACHINE_ID, BOXD_ACCEPT_COMMAND, expect.any(Number));
    // Nothing secret rides a command line.
    expect(JSON.stringify(api.exec.mock.calls)).not.toContain("sandbox-auth-secret");

    expect(result).toMatchObject({
      sandboxId: createConfig.sandboxId,
      providerObjectId: MACHINE_ID,
      lifetime: { kind: "none" },
    });
  });

  it("gives a later generation of the same sandbox its own machine name", async () => {
    const first = await boxdMachineName("openinspect", "sandbox-1", 1);
    expect(await boxdMachineName("openinspect", "sandbox-1", 1)).toBe(first);
    expect(await boxdMachineName("openinspect", "sandbox-1", 2)).not.toBe(first);
  });

  it("routes enabled services and tunnel ports through named proxies", async () => {
    const { api, files } = fakeApi();
    api.proxyDomains.mockResolvedValue({
      code: "code.openinspect-abc.boxd.sh",
      term: "term.openinspect-abc.boxd.sh",
      vnc: "vnc.openinspect-abc.boxd.sh",
      "port-3000": "port-3000.openinspect-abc.boxd.sh",
    });

    const result = await createProvider(api).createSandbox({
      ...createConfig,
      codeServerEnabled: true,
      vncEnabled: true,
      sandboxSettings: { terminalEnabled: true, tunnelPorts: [3000] },
    });

    const request = api.createMachine.mock.calls[0][0];
    expect(request.proxies.map(({ name }) => name)).toEqual(["code", "term", "vnc", "port-3000"]);
    expect(result.codeServerUrl).toBe("https://code.openinspect-abc.boxd.sh");
    expect(result.codeServerPassword).toBe(
      await deriveCodeServerPassword(createConfig.sandboxId, SECRET)
    );
    expect(result.ttydUrl).toBe("https://term.openinspect-abc.boxd.sh");
    expect(result.vncAccess?.url).toBe("https://vnc.openinspect-abc.boxd.sh");
    expect(result.vncAccess?.password).toBeTruthy();
    expect(result.tunnelUrls).toEqual({ "3000": "https://port-3000.openinspect-abc.boxd.sh" });

    const tunnels = files.find(({ path }) => path === BOXD_TUNNEL_INBOX_PATH);
    expect(tunnels?.content).toBe(
      `TUNNEL_SANDBOX_ID=${createConfig.sandboxId}\nTUNNEL_3000=https://port-3000.openinspect-abc.boxd.sh\n`
    );
    expect(sessionFile(files).parsed.env.EXPECTED_TUNNEL_PORTS).toBe("3000");
  });

  it("runs the session without links when the proxy lookup fails", async () => {
    const { api } = fakeApi();
    api.proxyDomains.mockRejectedValue(new BoxdApiError("unavailable", "connection"));

    const result = await createProvider(api).createSandbox({
      ...createConfig,
      codeServerEnabled: true,
    });

    expect(result.codeServerUrl).toBeUndefined();
    expect(api.exec).toHaveBeenCalledTimes(1);
  });

  it("adopts the machine a lost create answer made for the same sandbox", async () => {
    const { api } = fakeApi();
    api.createMachine.mockRejectedValue(new BoxdApiError("name taken", "conflict"));
    api.getMachine.mockResolvedValue(
      machine("running", { labels: { [BOXD_SANDBOX_LABEL]: createConfig.sandboxId } })
    );

    const result = await createProvider(api).createSandbox(createConfig);

    expect(api.getMachine).toHaveBeenCalledWith(api.createMachine.mock.calls[0][0].name);
    expect(result.providerObjectId).toBe(MACHINE_ID);
    expect(api.exec).toHaveBeenCalledTimes(1);
  });

  it("refuses a machine of that name that belongs to another sandbox", async () => {
    const { api } = fakeApi();
    api.createMachine.mockRejectedValue(new BoxdApiError("name taken", "conflict"));
    api.getMachine.mockResolvedValue(
      machine("running", { labels: { [BOXD_SANDBOX_LABEL]: "someone-else" } })
    );

    await expect(createProvider(api).createSandbox(createConfig)).rejects.toMatchObject({
      errorType: "permanent",
    });
    expect(api.exec).not.toHaveBeenCalled();
    expect(api.deleteMachine).not.toHaveBeenCalled();
  });

  it("deletes a machine whose launcher refused the session and fails the create", async () => {
    const { api } = fakeApi();
    api.exec.mockResolvedValue({ exitCode: 1, stdout: "", stderr: "not a session environment" });

    const error = await createProvider(api)
      .createSandbox(createConfig)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SandboxProviderError);
    expect((error as SandboxProviderError).errorType).toBe("permanent");
    expect((error as Error).message).toContain("not a session environment");
    expect(api.deleteMachine).toHaveBeenCalledWith(MACHINE_ID);
  });

  it("hands the manager a machine it could not delete after a failed create", async () => {
    const { api } = fakeApi();
    api.exec.mockResolvedValue({ exitCode: 1, stdout: "", stderr: "refused" });
    api.deleteMachine.mockRejectedValue(new BoxdApiError("unreachable", "connection"));

    const error = await createProvider(api)
      .createSandbox(createConfig)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SandboxLaunchRejectedError);
    expect((error as SandboxLaunchRejectedError).providerObjectId).toBe(MACHINE_ID);
  });

  it("adopts a machine a create made before its answer was lost", async () => {
    const { api } = fakeApi();
    api.createMachine.mockRejectedValue(new BoxdApiError("deadline exceeded", "server"));
    api.getMachine.mockResolvedValue(
      machine("pending", { labels: { [BOXD_SANDBOX_LABEL]: createConfig.sandboxId } })
    );

    const result = await createProvider(api).createSandbox(createConfig);

    expect(result.providerObjectId).toBe(MACHINE_ID);
    expect(api.waitUntilReady).toHaveBeenCalledWith(MACHINE_ID, expect.any(Number));
  });

  it.each([
    ["a lost answer", "connection", "transient"],
    ["a conflict", "conflict", "transient"],
  ] as const)(
    "reports the create's own error when %s left no machine behind",
    async (_name, kind, errorType) => {
      const { api } = fakeApi([null]);
      api.createMachine.mockRejectedValue(new BoxdApiError("original", kind));

      const error = await createProvider(api)
        .createSandbox(createConfig)
        .catch((caught: unknown) => caught);

      expect((error as Error).message).toContain("original");
      expect((error as SandboxProviderError).errorType).toBe(errorType);
      expect(api.deleteMachine).not.toHaveBeenCalled();
    }
  );

  it.each([
    ["connection", "transient"],
    ["rate_limited", "transient"],
    ["server", "transient"],
    ["authentication", "permanent"],
    ["permission", "permanent"],
    ["request", "permanent"],
  ] as const)("classifies a %s failure as %s", async (kind, errorType) => {
    const { api } = fakeApi([null]);
    api.createMachine.mockRejectedValue(new BoxdApiError("boom", kind));

    await expect(createProvider(api).createSandbox(createConfig)).rejects.toMatchObject({
      errorType,
    });
    expect(api.deleteMachine).not.toHaveBeenCalled();
  });
});

describe("BoxdSandboxProvider.resumeSandbox", () => {
  it.each([
    ["hibernated", "wake"],
    ["suspended", "resume"],
    ["stopped", "start"],
  ] as const)(
    "brings a %s machine back with %s and restarts nothing else",
    async (status, call) => {
      const { api } = fakeApi([status, "starting"]);

      const result = await createProvider(api).resumeSandbox(resumeConfig);

      expect(api[call]).toHaveBeenCalledWith(MACHINE_ID);
      for (const other of ["wake", "resume", "start"] as const) {
        if (other !== call) expect(api[other]).not.toHaveBeenCalled();
      }
      expect(api.waitUntilReady).toHaveBeenCalledWith(MACHINE_ID, expect.any(Number));
      expect(api.exec).toHaveBeenCalledWith(MACHINE_ID, BOXD_ACCEPT_COMMAND, expect.any(Number));
      expect(api.writeFile).not.toHaveBeenCalled();
      expect(result).toMatchObject({ success: true, providerObjectId: MACHINE_ID });
    }
  );

  it("waits for a started machine to leave stopped before the readiness wait", async () => {
    // boxd answers the start before the status moves, and the readiness wait
    // treats `stopped` as final.
    const { api } = fakeApi(["stopped", "stopped", "stopped", "starting"]);

    const result = await createProvider(api).resumeSandbox(resumeConfig);

    expect(result.success).toBe(true);
    expect(api.getMachine).toHaveBeenCalledTimes(4);
    expect(api.getMachine.mock.invocationCallOrder[3]).toBeLessThan(
      api.waitUntilReady.mock.invocationCallOrder[0]
    );
  });

  it("fails transiently when a started machine never leaves stopped", async () => {
    const { api } = fakeApi(["stopped"]);

    await expect(createProvider(api).resumeSandbox(resumeConfig)).rejects.toMatchObject({
      errorType: "transient",
    });
    expect(api.waitUntilReady).not.toHaveBeenCalled();
  });

  it("fails transiently when the machine is mid-change", async () => {
    const { api } = fakeApi(["hibernated"]);
    api.wake.mockRejectedValue(new BoxdApiError("hibernate in progress", "conflict"));

    await expect(createProvider(api).resumeSandbox(resumeConfig)).rejects.toMatchObject({
      errorType: "transient",
    });
  });

  it("asks for a fresh sandbox when the machine disappears during the proxy lookup", async () => {
    const { api } = fakeApi(["hibernated"]);
    api.proxyDomains.mockRejectedValue(new BoxdApiError("gone", "not_found"));

    const result = await createProvider(api).resumeSandbox({
      ...resumeConfig,
      codeServerEnabled: true,
    });

    expect(result).toMatchObject({ success: false, shouldSpawnFresh: true });
  });

  it("leaves a running machine as it is and only checks the runtime service", async () => {
    const { api } = fakeApi(["running"]);

    const result = await createProvider(api).resumeSandbox(resumeConfig);

    expect(api.wake).not.toHaveBeenCalled();
    expect(api.start).not.toHaveBeenCalled();
    expect(api.exec).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
  });

  it.each([[null], ["failed"], ["destroyed"]] as const)(
    "asks for a fresh sandbox when the machine is %s",
    async (status) => {
      const { api } = fakeApi([status]);

      const result = await createProvider(api).resumeSandbox(resumeConfig);

      expect(result).toMatchObject({ success: false, shouldSpawnFresh: true });
      expect(api.exec).not.toHaveBeenCalled();
    }
  );

  it("asks for a fresh sandbox when the machine disappears while waking", async () => {
    const { api } = fakeApi(["hibernated"]);
    api.wake.mockRejectedValue(new BoxdApiError("gone", "not_found"));

    const result = await createProvider(api).resumeSandbox(resumeConfig);

    expect(result).toMatchObject({ success: false, shouldSpawnFresh: true });
  });

  it("returns the proxy URLs again", async () => {
    const { api } = fakeApi(["hibernated"]);
    api.proxyDomains.mockResolvedValue({ code: "code.openinspect-abc.boxd.sh" });

    const result = await createProvider(api).resumeSandbox({
      ...resumeConfig,
      codeServerEnabled: true,
    });

    expect(result.codeServerUrl).toBe("https://code.openinspect-abc.boxd.sh");
    expect(result.codeServerPassword).toBe(
      await deriveCodeServerPassword(createConfig.sandboxId, SECRET)
    );
  });

  it("fails transiently when boxd cannot be reached", async () => {
    const { api } = fakeApi(["hibernated"]);
    api.wake.mockRejectedValue(new BoxdApiError("unreachable", "connection"));

    await expect(createProvider(api).resumeSandbox(resumeConfig)).rejects.toMatchObject({
      errorType: "transient",
    });
  });
});

describe("BoxdSandboxProvider.stopSandbox", () => {
  const stop = { providerObjectId: MACHINE_ID, sessionId: "session-1", reason: "idle" };

  it("hibernates a running machine and waits until boxd reports it hibernated", async () => {
    // boxd answers the hibernate before the memory is written; the machine
    // reads as suspended until then.
    const { api } = fakeApi(["running", "suspended", "suspended", "hibernated"]);

    const result = await createProvider(api).stopSandbox({ ...stop, intent: "preserve" });

    expect(api.hibernate).toHaveBeenCalledTimes(1);
    expect(api.getMachine).toHaveBeenCalledTimes(4);
    expect(api.deleteMachine).not.toHaveBeenCalled();
    expect(result).toEqual({ success: true });
  });

  it("waits for a hibernate already in progress instead of failing the retried stop", async () => {
    const { api } = fakeApi(["suspended", "suspended", "hibernated"]);
    api.hibernate.mockRejectedValue(new BoxdApiError("hibernate in progress", "conflict"));

    const result = await createProvider(api).stopSandbox({ ...stop, intent: "preserve" });

    expect(result).toEqual({ success: true });
  });

  it("does not hibernate a machine that is already hibernated", async () => {
    const { api } = fakeApi(["hibernated"]);

    const result = await createProvider(api).stopSandbox({ ...stop, intent: "preserve" });

    expect(api.hibernate).not.toHaveBeenCalled();
    expect(result).toEqual({ success: true });
  });

  it("reports a hibernate boxd did not confirm before the deadline", async () => {
    const { api } = fakeApi(["running", "suspended"]);

    const result = await createProvider(api).stopSandbox({
      ...stop,
      intent: "preserve",
      deadlineAtMs: clockMs + 5_000,
    });

    expect(result).toEqual({
      success: false,
      error: "Timed out before boxd confirmed the machine was hibernated (last suspended)",
    });
    expect(api.getMachine.mock.calls.length).toBeLessThanOrEqual(4);
  });

  it("reports a machine that disappeared before it was preserved", async () => {
    const { api } = fakeApi([null]);

    const result = await createProvider(api).stopSandbox({ ...stop, intent: "preserve" });

    expect(result.success).toBe(false);
    expect(api.hibernate).not.toHaveBeenCalled();
  });

  it("deletes the machine for a terminal stop, and a missing one counts as deleted", async () => {
    const { api } = fakeApi();

    expect(await createProvider(api).stopSandbox({ ...stop, intent: "destroy" })).toEqual({
      success: true,
    });
    expect(api.deleteMachine).toHaveBeenCalledWith(MACHINE_ID);
    expect(api.hibernate).not.toHaveBeenCalled();

    api.deleteMachine.mockRejectedValue(new BoxdApiError("gone", "not_found"));
    expect(await createProvider(api).stopSandbox({ ...stop, intent: "destroy" })).toEqual({
      success: true,
    });
  });

  it("does not start a stop after its deadline", async () => {
    const { api } = fakeApi();

    await expect(
      createProvider(api).stopSandbox({ ...stop, intent: "destroy", deadlineAtMs: clockMs - 1 })
    ).rejects.toMatchObject({ errorType: "transient" });
    expect(api.deleteMachine).not.toHaveBeenCalled();
  });
});
