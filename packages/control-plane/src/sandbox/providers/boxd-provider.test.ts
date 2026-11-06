import { beforeEach, describe, expect, it, vi } from "vitest";
import { computeHmacHex } from "@open-inspect/shared/auth";
import {
  BOXD_LABELS,
  BOXD_LAUNCH_COMMAND,
  BOXD_LAUNCHER_PATH,
  BOXD_SANDBOX_VERSION,
  BOXD_SESSION_ENV_FILE_PATH,
  BOXD_TUNNEL_ENV_FILE_PATH,
  boxdCreateKey,
  boxdMachineName,
  classifyBoxdError,
  renderBoxdSessionEnvFile,
  resolveBoxdMachineSize,
} from "./boxd-provider";
import {
  baseCreateConfig,
  boxdMachine,
  createProvider,
  execAnswering,
  MACHINE_ID,
  mockClient,
  providerConfig,
  proxyStore,
  sessionEnv,
  sessionEnvFile,
} from "./boxd-provider.test-helpers";
import { SandboxProviderError } from "../provider";
import {
  BOXD_GRPC_STATUS,
  BoxdApiError,
  BoxdCancelledError,
  BoxdConflictError,
  BoxdNotFoundError,
} from "../boxd-client";
import { RequestDeadlineError } from "../request-deadline";

const resumeConfig = {
  providerObjectId: MACHINE_ID,
  sessionId: "sess-1",
  sandboxId: "sandbox-logical",
  codeServerEnabled: true,
};

describe("BoxdSandboxProvider", () => {
  beforeEach(() => vi.clearAllMocks());

  describe("createSandbox", () => {
    it("restores the base snapshot under a deterministic name and labels, private and unresized", async () => {
      const client = mockClient();
      const result = await createProvider(client).createSandbox(baseCreateConfig);

      const createKey = await boxdCreateKey("test", "sess-1", "sandbox-logical");
      expect(client.createFromSnapshot).toHaveBeenCalledOnce();
      expect(client.createFromSnapshot).toHaveBeenCalledWith({
        snapshot: "open-inspect-abc123",
        name: boxdMachineName("test", createKey),
        labels: {
          [BOXD_LABELS.deployment]: "test",
          [BOXD_LABELS.session]: "sess-1",
          [BOXD_LABELS.sandbox]: "sandbox-logical",
          [BOXD_LABELS.createKey]: createKey,
        },
      });
      expect(result).toMatchObject({
        sandboxId: "sandbox-logical",
        providerObjectId: MACHINE_ID,
        lifetime: { kind: "none" },
        codeServerUrl: "https://code.oi-test-0123456789abcdef.boxd.sh",
        codeServerPassword: (await computeHmacHex("code-server:sandbox-logical", "secret")).slice(
          0,
          32
        ),
      });
      expect(result.tunnelUrls).toBeUndefined();
      expect(client.createProxy).toHaveBeenCalledWith(MACHINE_ID, "code", 8080);
      // The snapshot is already the default size, and private.
      expect(client.resizeMachine).not.toHaveBeenCalled();
      expect(client.unshareMachine).not.toHaveBeenCalled();
      expect(client.deleteMachine).not.toHaveBeenCalled();
    });

    it("adds the configured extra labels without letting them override its own", async () => {
      const client = mockClient();
      await createProvider(client, {
        ...providerConfig,
        extraLabels: { team: "platform", [BOXD_LABELS.session]: "spoofed" },
      }).createSandbox(baseCreateConfig);
      const [params] = vi.mocked(client.createFromSnapshot).mock.calls[0];
      expect(params.labels).toMatchObject({ team: "platform", [BOXD_LABELS.session]: "sess-1" });
    });

    it("writes the env file privately, then routes, then starts the launcher", async () => {
      const client = mockClient();
      const order: string[] = [];
      vi.mocked(client.writeFile).mockImplementation(async (_id, file) => {
        order.push(`write:${file.path}`);
      });
      const store = proxyStore();
      vi.mocked(client.listProxies).mockImplementation(store.listProxies);
      vi.mocked(client.createProxy).mockImplementation(async (id, name, port) => {
        order.push("proxy");
        await store.createProxy(id, name, port);
      });
      const exec = execAnswering();
      vi.mocked(client.exec).mockImplementation(async (id, command) => {
        if (command === BOXD_LAUNCH_COMMAND) order.push("launch");
        return exec(id, command);
      });

      await createProvider(client).createSandbox(baseCreateConfig);

      expect(order).toEqual([`write:${BOXD_SESSION_ENV_FILE_PATH}`, "proxy", "launch"]);
      const [, envWrite] = vi.mocked(client.writeFile).mock.calls[0];
      expect(envWrite.mode).toBe(0o600);
      expect(envWrite.secretValues).toMatchObject({ SANDBOX_AUTH_TOKEN: "tok" });
      // No session value ever rides a command line.
      for (const [, command] of vi.mocked(client.exec).mock.calls) {
        expect(command).not.toContain("tok");
      }
      expect(BOXD_LAUNCH_COMMAND).toContain(BOXD_LAUNCHER_PATH);
    });

    it("delivers the session env with system vars and boot markers overriding user vars", async () => {
      const client = mockClient();
      await createProvider(client).createSandbox({
        ...baseCreateConfig,
        userEnvVars: {
          SANDBOX_ID: "evil",
          SANDBOX_VERSION: "v0-evil",
          RESTORED_FROM_SNAPSHOT: "true",
          KEEP_ME: "it's quoted\nacross lines",
        },
      });
      const env = sessionEnv(client);
      expect(env).toMatchObject({
        SANDBOX_ID: "sandbox-logical",
        SANDBOX_VERSION: BOXD_SANDBOX_VERSION,
        SANDBOX_AUTH_TOKEN: "tok",
        RESTORED_FROM_SNAPSHOT: "false",
        FROM_REPO_IMAGE: "false",
        IMAGE_BUILD_MODE: "false",
        OI_DEFERRED_START: "false",
        VCS_HOST: "github.com",
      });
      // A value with a quote and a newline survives the shell quoting intact.
      expect(sessionEnvFile(client)).toContain(`export KEEP_ME='it'\\''s quoted\nacross lines'`);
    });

    it("routes terminal, VNC and tunnel ports and writes the tunnel env file into the workspace", async () => {
      const client = mockClient();
      const result = await createProvider(client).createSandbox({
        ...baseCreateConfig,
        vncEnabled: true,
        sandboxSettings: { terminalEnabled: true, tunnelPorts: [3000] },
      });

      expect(result.ttydUrl).toBe("https://terminal.oi-test-0123456789abcdef.boxd.sh");
      expect(result.vncAccess?.url).toBe("https://vnc.oi-test-0123456789abcdef.boxd.sh");
      expect(result.vncAccess?.password).toBeTruthy();
      expect(result.tunnelUrls).toEqual({
        "3000": "https://port-3000.oi-test-0123456789abcdef.boxd.sh",
      });
      expect(client.writeFile).toHaveBeenCalledWith(MACHINE_ID, {
        path: BOXD_TUNNEL_ENV_FILE_PATH,
        content:
          "TUNNEL_SANDBOX_ID=sandbox-logical\nTUNNEL_3000=https://port-3000.oi-test-0123456789abcdef.boxd.sh\n",
      });
      expect(sessionEnv(client).EXPECTED_TUNNEL_PORTS).toBe("3000");
    });

    it("resizes a machine to the smallest size that fits the requested resources", async () => {
      const client = mockClient();
      await createProvider(client).createSandbox({
        ...baseCreateConfig,
        sandboxSettings: { cpuCores: 3, memoryMib: 4096 },
      });
      expect(client.resizeMachine).toHaveBeenCalledWith(MACHINE_ID, 4);
    });

    it("rejects a port boxd holds before creating anything", async () => {
      const client = mockClient();
      await expect(
        createProvider(client).createSandbox({
          ...baseCreateConfig,
          sandboxSettings: { tunnelPorts: [57073] },
        })
      ).rejects.toMatchObject({
        errorType: "permanent",
        message: expect.stringContaining("57073"),
      });
      expect(client.createFromSnapshot).not.toHaveBeenCalled();
    });

    it("refuses an env name the launcher could not export, naming it but not its value", async () => {
      const client = mockClient();
      const error = await createProvider(client)
        .createSandbox({ ...baseCreateConfig, userEnvVars: { "BAD-NAME": "hunter2" } })
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(SandboxProviderError);
      expect((error as SandboxProviderError).errorType).toBe("permanent");
      expect((error as Error).message).toContain("BAD-NAME");
      expect((error as Error).message).not.toContain("hunter2");
      expect(client.createFromSnapshot).not.toHaveBeenCalled();
    });

    it("makes a machine that reports itself shared private before writing to it", async () => {
      const getMachine = vi
        .fn()
        .mockResolvedValueOnce(boxdMachine({ shared: false }))
        .mockResolvedValue(boxdMachine());
      const client = mockClient({
        createFromSnapshot: vi.fn(async () => boxdMachine({ shared: true })),
        getMachine,
      });
      await createProvider(client).createSandbox(baseCreateConfig);
      expect(client.unshareMachine).toHaveBeenCalledWith(MACHINE_ID);
      expect(vi.mocked(client.unshareMachine).mock.invocationCallOrder[0]).toBeLessThan(
        vi.mocked(client.writeFile).mock.invocationCallOrder[0]
      );
    });

    it("deletes a machine that stays shared and never writes the env to it", async () => {
      const client = mockClient({
        createFromSnapshot: vi.fn(async () => boxdMachine({ shared: true })),
        getMachine: vi.fn(async () => boxdMachine({ shared: true })),
      });
      await expect(createProvider(client).createSandbox(baseCreateConfig)).rejects.toMatchObject({
        errorType: "permanent",
        message: expect.stringContaining("stayed shared"),
      });
      expect(client.writeFile).not.toHaveBeenCalled();
      expect(client.deleteMachine).toHaveBeenCalledWith(MACHINE_ID);
    });

    it("repeats a create whose response was lost and adopts the machine the first one made", async () => {
      const createKey = await boxdCreateKey("test", "sess-1", "sandbox-logical");
      const client = mockClient({
        createFromSnapshot: vi
          .fn()
          .mockRejectedValueOnce(
            new BoxdApiError("boxd createFromSnapshot failed", BOXD_GRPC_STATUS.UNAVAILABLE)
          )
          .mockRejectedValueOnce(
            new BoxdConflictError("name taken", BOXD_GRPC_STATUS.ALREADY_EXISTS)
          ),
        getMachine: vi.fn(async () =>
          boxdMachine({ labels: { [BOXD_LABELS.createKey]: createKey } })
        ),
      });
      const result = await createProvider(client).createSandbox(baseCreateConfig);
      expect(client.createFromSnapshot).toHaveBeenCalledTimes(2);
      expect(vi.mocked(client.getMachine).mock.calls[0][0]).toBe(
        boxdMachineName("test", createKey)
      );
      expect(result.providerObjectId).toBe(MACHINE_ID);
    });

    it("refuses a taken name it did not create, without deleting that machine", async () => {
      const client = mockClient({
        createFromSnapshot: vi.fn(async () => {
          throw new BoxdConflictError("name taken", BOXD_GRPC_STATUS.ALREADY_EXISTS);
        }),
        getMachine: vi.fn(async () => boxdMachine({ labels: { other: "x" } })),
      });
      await expect(createProvider(client).createSandbox(baseCreateConfig)).rejects.toMatchObject({
        errorType: "permanent",
        message: expect.stringContaining("did not create"),
      });
      expect(client.deleteMachine).not.toHaveBeenCalled();
    });

    it("does not repeat a refused create and classifies it permanent", async () => {
      const client = mockClient({
        createFromSnapshot: vi.fn(async () => {
          throw new BoxdNotFoundError("snapshot not found");
        }),
      });
      await expect(createProvider(client).createSandbox(baseCreateConfig)).rejects.toMatchObject({
        errorType: "permanent",
      });
      expect(client.createFromSnapshot).toHaveBeenCalledOnce();
    });

    it("deletes the machine and fails permanently when the launcher exits at once", async () => {
      const client = mockClient({
        exec: execAnswering({ launcherExit: "1", logTail: "runtime toolchain missing" }),
      });
      await expect(createProvider(client).createSandbox(baseCreateConfig)).rejects.toMatchObject({
        errorType: "permanent",
        message: expect.stringContaining("runtime toolchain missing"),
      });
      expect(client.deleteMachine).toHaveBeenCalledWith(MACHINE_ID);
    });

    it("deletes a machine that fails to start", async () => {
      const client = mockClient({
        getMachine: vi.fn(async () => boxdMachine({ status: "failed" })),
      });
      await expect(createProvider(client).createSandbox(baseCreateConfig)).rejects.toMatchObject({
        errorType: "permanent",
      });
      expect(client.deleteMachine).toHaveBeenCalledWith(MACHINE_ID);
    });

    it("waits for a machine that is still starting and does not answer commands yet", async () => {
      const exec = execAnswering();
      const client = mockClient({
        getMachine: vi
          .fn()
          .mockResolvedValueOnce(boxdMachine({ status: "starting" }))
          .mockResolvedValue(boxdMachine()),
        exec: vi
          .fn()
          .mockRejectedValueOnce(new BoxdApiError("not ready", BOXD_GRPC_STATUS.UNAVAILABLE))
          .mockImplementation(exec),
      });
      await expect(createProvider(client).createSandbox(baseCreateConfig)).resolves.toMatchObject({
        providerObjectId: MACHINE_ID,
      });
      expect(client.getMachine).toHaveBeenCalledTimes(3);
    });

    it("keeps a failed route from hiding the live sandbox", async () => {
      const client = mockClient({
        createProxy: vi.fn(async () => {
          throw new BoxdApiError("proxy refused", BOXD_GRPC_STATUS.INVALID_ARGUMENT);
        }),
      });
      const result = await createProvider(client).createSandbox(baseCreateConfig);
      expect(result.codeServerUrl).toBeUndefined();
      expect(client.deleteMachine).not.toHaveBeenCalled();
    });
  });

  describe("resumeSandbox", () => {
    it("spawns fresh when the machine is gone from boxd", async () => {
      const client = mockClient({
        getMachine: vi.fn(async () => {
          throw new BoxdNotFoundError("VM not found");
        }),
      });
      await expect(createProvider(client).resumeSandbox(resumeConfig)).resolves.toEqual({
        success: false,
        error: "Sandbox no longer exists in boxd",
        shouldSpawnFresh: true,
      });
    });

    it.each(["destroyed", "failed"])("spawns fresh for a %s machine", async (status) => {
      const client = mockClient({ getMachine: vi.fn(async () => boxdMachine({ status })) });
      await expect(createProvider(client).resumeSandbox(resumeConfig)).resolves.toMatchObject({
        success: false,
        shouldSpawnFresh: true,
      });
      expect(client.wakeMachine).not.toHaveBeenCalled();
    });

    it("wakes a hibernated machine, reuses its routes and finds the runtime still running", async () => {
      const store = proxyStore();
      store.proxies.push({
        name: "code",
        domain: "code.oi-test-0123456789abcdef.boxd.sh",
        port: 8080,
      });
      const client = mockClient({
        getMachine: vi
          .fn()
          .mockResolvedValueOnce(boxdMachine({ status: "hibernated" }))
          .mockResolvedValue(boxdMachine()),
        listProxies: store.listProxies,
        createProxy: store.createProxy,
        exec: execAnswering({ launcherExit: "75" }),
      });
      const result = await createProvider(client).resumeSandbox(resumeConfig);

      expect(result).toMatchObject({
        success: true,
        providerObjectId: MACHINE_ID,
        lifetime: { kind: "none" },
        codeServerUrl: "https://code.oi-test-0123456789abcdef.boxd.sh",
      });
      expect(client.wakeMachine).toHaveBeenCalledWith(MACHINE_ID);
      expect(client.startMachine).not.toHaveBeenCalled();
      expect(client.createProxy).not.toHaveBeenCalled();
      expect(vi.mocked(client.exec).mock.calls.map(([, command]) => command)).toContain(
        BOXD_LAUNCH_COMMAND
      );
      // The env file is the create's; a resume never rewrites it.
      expect(client.writeFile).not.toHaveBeenCalled();
    });

    it("cold-starts a stopped machine and launches the runtime", async () => {
      const client = mockClient({
        getMachine: vi
          .fn()
          .mockResolvedValueOnce(boxdMachine({ status: "stopped" }))
          .mockResolvedValue(boxdMachine()),
      });
      await expect(createProvider(client).resumeSandbox(resumeConfig)).resolves.toMatchObject({
        success: true,
      });
      expect(client.startMachine).toHaveBeenCalledWith(MACHINE_ID);
      expect(client.wakeMachine).not.toHaveBeenCalled();
    });

    it("leaves a running machine as it is and still makes sure the runtime runs", async () => {
      const client = mockClient();
      await createProvider(client).resumeSandbox(resumeConfig);
      expect(client.wakeMachine).not.toHaveBeenCalled();
      expect(client.startMachine).not.toHaveBeenCalled();
      expect(vi.mocked(client.exec).mock.calls.map(([, command]) => command)).toContain(
        BOXD_LAUNCH_COMMAND
      );
    });

    it("spawns fresh when the machine disappears while it is being brought back", async () => {
      const client = mockClient({
        getMachine: vi.fn(async () => boxdMachine({ status: "hibernated" })),
        wakeMachine: vi.fn(async () => {
          throw new BoxdNotFoundError("VM not found");
        }),
      });
      await expect(createProvider(client).resumeSandbox(resumeConfig)).resolves.toMatchObject({
        success: false,
        shouldSpawnFresh: true,
      });
    });

    it("makes a shared machine private before resuming it", async () => {
      const client = mockClient({
        getMachine: vi
          .fn()
          .mockResolvedValueOnce(boxdMachine({ shared: true }))
          .mockResolvedValueOnce(boxdMachine({ shared: true }))
          .mockResolvedValue(boxdMachine()),
      });
      await createProvider(client).resumeSandbox(resumeConfig);
      expect(client.unshareMachine).toHaveBeenCalledWith(MACHINE_ID);
    });

    it("surfaces a transient failure as transient rather than spawning fresh", async () => {
      const client = mockClient({
        getMachine: vi.fn(async () => {
          throw new BoxdApiError("unavailable", BOXD_GRPC_STATUS.UNAVAILABLE);
        }),
      });
      await expect(createProvider(client).resumeSandbox(resumeConfig)).rejects.toMatchObject({
        errorType: "transient",
      });
    });
  });

  describe("stopSandbox", () => {
    const stopConfig = {
      providerObjectId: MACHINE_ID,
      sessionId: "sess-1",
      reason: "inactivity_timeout",
    };

    it("hibernates for preserve and confirms it", async () => {
      const client = mockClient({
        getMachine: vi
          .fn()
          .mockResolvedValueOnce(boxdMachine({ status: "suspended" }))
          .mockResolvedValue(boxdMachine({ status: "hibernated" })),
      });
      await expect(
        createProvider(client).stopSandbox({ ...stopConfig, intent: "preserve" })
      ).resolves.toEqual({ success: true });
      expect(client.hibernateMachine).toHaveBeenCalledWith(MACHINE_ID, expect.anything());
      expect(client.deleteMachine).not.toHaveBeenCalled();
    });

    it("accepts a machine boxd had already hibernated", async () => {
      const client = mockClient({
        hibernateMachine: vi.fn(async () => {
          throw new BoxdConflictError("not running", BOXD_GRPC_STATUS.FAILED_PRECONDITION);
        }),
        getMachine: vi.fn(async () => boxdMachine({ status: "hibernated" })),
      });
      await expect(
        createProvider(client).stopSandbox({ ...stopConfig, intent: "preserve" })
      ).resolves.toEqual({ success: true });
    });

    it("asks again when the machine stays running after the request", async () => {
      const client = mockClient({
        getMachine: vi
          .fn()
          .mockResolvedValueOnce(boxdMachine())
          .mockResolvedValueOnce(boxdMachine())
          .mockResolvedValueOnce(boxdMachine())
          .mockImplementation(async () => {
            await new Promise((resolve) => setTimeout(resolve, 10));
            return vi.mocked(client.hibernateMachine).mock.calls.length > 1
              ? boxdMachine({ status: "hibernated" })
              : boxdMachine();
          }),
      });
      await expect(
        createProvider(client).stopSandbox({ ...stopConfig, intent: "preserve" })
      ).resolves.toEqual({ success: true });
      expect(vi.mocked(client.hibernateMachine).mock.calls.length).toBeGreaterThan(1);
    });

    it("accepts a machine that stays suspended past the grace period as preserved", async () => {
      const client = mockClient({
        getMachine: vi.fn(async () => boxdMachine({ status: "suspended" })),
      });
      await expect(
        createProvider(client).stopSandbox({ ...stopConfig, intent: "preserve" })
      ).resolves.toEqual({ success: true });
      expect(client.hibernateMachine).toHaveBeenCalledOnce();
    });

    it("keeps waiting through a read that fails transiently", async () => {
      const client = mockClient({
        getMachine: vi
          .fn()
          .mockRejectedValueOnce(new BoxdApiError("unavailable", BOXD_GRPC_STATUS.UNAVAILABLE))
          .mockResolvedValue(boxdMachine({ status: "hibernated" })),
      });
      await expect(
        createProvider(client).stopSandbox({ ...stopConfig, intent: "preserve" })
      ).resolves.toEqual({ success: true });
    });

    it("does not claim graceful shutdown when the machine is missing", async () => {
      const client = mockClient({
        hibernateMachine: vi.fn(async () => {
          throw new BoxdNotFoundError("VM not found");
        }),
      });
      await expect(
        createProvider(client).stopSandbox({ ...stopConfig, intent: "preserve" })
      ).resolves.toEqual({
        success: false,
        error: "Sandbox disappeared before graceful shutdown was verified",
      });
    });

    it("reports a timeout instead of success when the hibernate outlasts the deadline", async () => {
      const client = mockClient({ getMachine: vi.fn(async () => boxdMachine()) });
      await expect(
        createProvider(client).stopSandbox({
          ...stopConfig,
          intent: "preserve",
          deadlineAtMs: Date.now() + 20,
        })
      ).resolves.toMatchObject({ success: false, error: expect.stringContaining("Timed out") });
    });

    it("deletes for destroy and treats a missing machine as already gone", async () => {
      const client = mockClient();
      await expect(
        createProvider(client).stopSandbox({ ...stopConfig, intent: "destroy" })
      ).resolves.toEqual({ success: true });
      expect(client.deleteMachine).toHaveBeenCalledWith(MACHINE_ID, expect.anything());

      vi.mocked(client.deleteMachine).mockRejectedValueOnce(new BoxdNotFoundError("gone"));
      await expect(
        createProvider(client).stopSandbox({ ...stopConfig, intent: "destroy" })
      ).resolves.toEqual({ success: true });
    });

    it("surfaces a refused delete classified by its code", async () => {
      const client = mockClient({
        deleteMachine: vi.fn(async () => {
          throw new BoxdApiError("denied", BOXD_GRPC_STATUS.PERMISSION_DENIED);
        }),
      });
      await expect(
        createProvider(client).stopSandbox({ ...stopConfig, intent: "destroy" })
      ).rejects.toMatchObject({ errorType: "permanent" });
    });
  });

  it("declares persistent resume and no configurable timeout", () => {
    expect(createProvider(mockClient()).capabilities).toEqual({
      supportsSandboxTimeout: false,
      supportsSnapshots: false,
      supportsRestore: false,
      supportsPersistentResume: true,
      supportsExplicitStop: true,
    });
  });
});

describe("boxd provider helpers", () => {
  it("selects the smallest machine size that fits, or the default", () => {
    expect(resolveBoxdMachineSize(undefined, "2x8")).toBe("2x8");
    expect(resolveBoxdMachineSize({ cpuCores: 1 }, "2x8")).toBe("1x4");
    expect(resolveBoxdMachineSize({ memoryMib: 8192 }, "1x4")).toBe("2x8");
    expect(resolveBoxdMachineSize({ cpuCores: 2, memoryMib: 9000 }, "1x4")).toBe("4x16");
    expect(() => resolveBoxdMachineSize({ cpuCores: 16 }, "2x8")).toThrow(SandboxProviderError);
  });

  it("names machines as one DNS label, readable and unique per create key", async () => {
    const key = await boxdCreateKey("prod", "s", "x");
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(boxdMachineName("prod", key)).toBe(`prod-${key.slice(0, 16)}`);
    const long = boxdMachineName("My_Deployment.Name-".repeat(5), key);
    expect(long.length).toBeLessThanOrEqual(63);
    expect(long).toMatch(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/);
    expect(boxdMachineName("___", key)).toBe(`oi-${key.slice(0, 16)}`);
    expect(boxdMachineName("42-prod", key)).toBe(`prod-${key.slice(0, 16)}`);
  });

  it("renders the env file sorted, single-quoted, and refuses non-identifier names", () => {
    expect(renderBoxdSessionEnvFile({ B: "2", A: "x'y" })).toBe(
      "# Open-Inspect session env, written by the control plane.\nexport A='x'\\''y'\nexport B='2'\n"
    );
    expect(() => renderBoxdSessionEnvFile({ "1BAD": "v" })).toThrow(SandboxProviderError);
  });

  it("classifies failures by gRPC code, cancellation and deadline", () => {
    expect(
      classifyBoxdError("x", new BoxdApiError("unavailable", BOXD_GRPC_STATUS.UNAVAILABLE))
        .errorType
    ).toBe("transient");
    expect(
      classifyBoxdError("x", new BoxdApiError("quota", BOXD_GRPC_STATUS.RESOURCE_EXHAUSTED))
        .errorType
    ).toBe("transient");
    expect(
      classifyBoxdError("x", new BoxdApiError("bad key", BOXD_GRPC_STATUS.UNAUTHENTICATED))
        .errorType
    ).toBe("permanent");
    expect(classifyBoxdError("x", new BoxdApiError("no connection", undefined)).errorType).toBe(
      "transient"
    );
    expect(classifyBoxdError("x", new BoxdCancelledError("get")).errorType).toBe("transient");
    expect(
      classifyBoxdError("x", new RequestDeadlineError("boxd", "getMachine", 10)).errorType
    ).toBe("transient");
  });
});
