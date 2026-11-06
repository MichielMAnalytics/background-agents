import { describe, expect, it, vi } from "vitest";
import {
  BOXD_GRPC_STATUS,
  BoxdApiError,
  BoxdCancelledError,
  BoxdClient,
  BoxdConflictError,
  BoxdNotFoundError,
  boxdSizeResources,
  delayUnlessCancelled,
  isBoxdMachineSize,
  type BoxdSdk,
  type BoxdSdkMachine,
} from "./boxd-client";
import { RequestDeadlineError } from "./request-deadline";

function sdkMachine(overrides: Partial<BoxdSdkMachine> = {}): BoxdSdkMachine {
  return {
    id: "m-1",
    name: "oi-test-abc",
    status: "running",
    resources: { vcpu: 2, memoryBytes: 8 * 1024 ** 3 },
    shared: false,
    labels: { a: "b" },
    ...overrides,
  };
}

/** An SDK stand-in: every call resolves unless a test overrides it. */
function fakeSdk() {
  const sdk = {
    machines: {
      create: vi.fn(async () => sdkMachine()),
      get: vi.fn(async () => sdkMachine()),
      delete: vi.fn(async () => {}),
      start: vi.fn(async () => {}),
      hibernate: vi.fn(async () => {}),
      wake: vi.fn(async () => {}),
      unshare: vi.fn(async () => {}),
      resize: vi.fn(async () => ({})),
      exec: vi.fn(async () => ({ exitCode: 0, stdout: "out", stderr: "" })),
      fs: { write: vi.fn(async () => ({})) },
      proxies: {
        create: vi.fn(async () => ({})),
        list: vi.fn(async () => [{ name: "code", domain: "code.m.boxd.sh", port: 8080 }]),
      },
    },
  };
  return sdk;
}

/** An error shaped like the SDK's BoxdError subclasses. */
function sdkError(message: string, grpcCode?: number, reason?: string): Error {
  return Object.assign(new Error(message), { grpcCode, reason, name: "BoxdError" });
}

function clientWith(sdk: ReturnType<typeof fakeSdk>, org?: string) {
  const factory = vi.fn(async () => sdk as unknown as BoxdSdk);
  return { client: new BoxdClient({ apiKey: "test-boxd-key", org }, factory), factory };
}

describe("BoxdClient", () => {
  it("requires an API key", () => {
    expect(() => new BoxdClient({ apiKey: "" })).toThrow("BoxdClient requires apiKey");
  });

  it("loads the SDK once, on first use, and retries a failed load", async () => {
    const sdk = fakeSdk();
    const factory = vi
      .fn<() => Promise<BoxdSdk>>()
      .mockRejectedValueOnce(new Error("load failed"))
      .mockResolvedValue(sdk as unknown as BoxdSdk);
    const client = new BoxdClient({ apiKey: "test-boxd-key" }, factory);
    expect(factory).not.toHaveBeenCalled();
    await expect(client.getMachine("m-1")).rejects.toThrow("load failed");
    await client.getMachine("m-1");
    await client.getMachine("m-1");
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it("restores from a snapshot isolated, in the configured org, named and labelled", async () => {
    const sdk = fakeSdk();
    const { client } = clientWith(sdk, "acme");
    const machine = await client.createFromSnapshot({
      snapshot: "open-inspect-abc",
      name: "oi-test-abc",
      labels: { k: "v" },
    });
    expect(sdk.machines.create).toHaveBeenCalledWith({
      fromSnapshot: "open-inspect-abc",
      name: "oi-test-abc",
      isolated: true,
      labels: { k: "v" },
      org: "acme",
    });
    expect(machine).toEqual({
      id: "m-1",
      name: "oi-test-abc",
      status: "running",
      vcpu: 2,
      memoryBytes: 8 * 1024 ** 3,
      shared: false,
      labels: { a: "b" },
    });
  });

  it("omits the org when none is configured", async () => {
    const sdk = fakeSdk();
    const { client } = clientWith(sdk);
    await client.createFromSnapshot({ snapshot: "s", name: "n", labels: {} });
    expect(sdk.machines.create).toHaveBeenCalledWith({
      fromSnapshot: "s",
      name: "n",
      isolated: true,
      labels: {},
    });
  });

  it("forwards lifecycle calls to the SDK", async () => {
    const sdk = fakeSdk();
    const { client } = clientWith(sdk);
    await client.hibernateMachine("m-1");
    await client.wakeMachine("m-1");
    await client.startMachine("m-1");
    await client.unshareMachine("m-1");
    await client.resizeMachine("m-1", 4);
    await client.deleteMachine("m-1");
    expect(sdk.machines.hibernate).toHaveBeenCalledWith("m-1");
    expect(sdk.machines.wake).toHaveBeenCalledWith("m-1");
    expect(sdk.machines.start).toHaveBeenCalledWith("m-1");
    expect(sdk.machines.unshare).toHaveBeenCalledWith("m-1");
    expect(sdk.machines.resize).toHaveBeenCalledWith("m-1", { vcpu: 4 });
    expect(sdk.machines.delete).toHaveBeenCalledWith("m-1");
  });

  it("runs commands under their own timeout in milliseconds", async () => {
    const sdk = fakeSdk();
    const { client } = clientWith(sdk);
    await expect(client.exec("m-1", "true", { timeoutSeconds: 15 })).resolves.toEqual({
      exitCode: 0,
      stdout: "out",
      stderr: "",
    });
    expect(sdk.machines.exec).toHaveBeenCalledWith("m-1", { command: "true", timeout: 15_000 });
  });

  it("writes files with an explicit mode, and lists and creates proxies", async () => {
    const sdk = fakeSdk();
    const { client } = clientWith(sdk);
    await client.writeFile("m-1", { path: "/p", content: "c", mode: 0o600 });
    await client.writeFile("m-1", { path: "/q", content: "d" });
    expect(sdk.machines.fs.write).toHaveBeenNthCalledWith(1, "m-1", "/p", "c", { mode: 0o600 });
    expect(sdk.machines.fs.write).toHaveBeenNthCalledWith(2, "m-1", "/q", "d", undefined);
    await client.createProxy("m-1", "code", 8080);
    expect(sdk.machines.proxies.create).toHaveBeenCalledWith("m-1", "code", 8080);
    await expect(client.listProxies("m-1")).resolves.toEqual([
      { name: "code", domain: "code.m.boxd.sh", port: 8080 },
    ]);
  });

  it("maps SDK errors to typed errors that keep the gRPC code and reason", async () => {
    const sdk = fakeSdk();
    const { client } = clientWith(sdk);
    sdk.machines.get.mockRejectedValueOnce(sdkError("VM not found", BOXD_GRPC_STATUS.NOT_FOUND));
    await expect(client.getMachine("m-1")).rejects.toBeInstanceOf(BoxdNotFoundError);

    sdk.machines.create.mockRejectedValueOnce(
      sdkError("name taken", BOXD_GRPC_STATUS.ALREADY_EXISTS)
    );
    await expect(
      client.createFromSnapshot({ snapshot: "s", name: "n", labels: {} })
    ).rejects.toBeInstanceOf(BoxdConflictError);

    sdk.machines.hibernate.mockRejectedValueOnce(
      sdkError("not running", BOXD_GRPC_STATUS.FAILED_PRECONDITION)
    );
    await expect(client.hibernateMachine("m-1")).rejects.toBeInstanceOf(BoxdConflictError);

    sdk.machines.get.mockRejectedValueOnce(
      sdkError("API key not recognized", BOXD_GRPC_STATUS.UNAUTHENTICATED, "invalid_token")
    );
    const auth = await client.getMachine("m-1").catch((error: unknown) => error);
    expect(auth).toBeInstanceOf(BoxdApiError);
    expect(auth).toMatchObject({
      grpcCode: BOXD_GRPC_STATUS.UNAUTHENTICATED,
      reason: "invalid_token",
      transient: false,
    });
    expect((auth as Error).message).toBe(
      "boxd getMachine failed with gRPC 16 (invalid_token): API key not recognized"
    );

    // A failure to reach boxd at all carries no code and is worth repeating.
    sdk.machines.get.mockRejectedValueOnce(
      Object.assign(new Error("fetch failed"), { name: "APIConnectionError" })
    );
    await expect(client.getMachine("m-1")).rejects.toMatchObject({
      grpcCode: undefined,
      transient: true,
    });
  });

  it("scrubs secret values out of a failed write, even one straddling the cutoff", async () => {
    const sdk = fakeSdk();
    const { client } = clientWith(sdk);
    const secret = "s3cr3t-value-".repeat(4);
    sdk.machines.fs.write.mockRejectedValueOnce(
      sdkError(`${"x".repeat(290)}${secret} rejected`, BOXD_GRPC_STATUS.INVALID_ARGUMENT)
    );
    const error = await client
      .writeFile("m-1", { path: "/p", content: secret, secretValues: { TOKEN: secret } })
      .catch((caught: unknown) => caught);
    expect((error as Error).message).not.toContain("s3cr3t");
    expect((error as Error).message).toContain("[redact");
  });

  it("surfaces a request deadline as RequestDeadlineError", async () => {
    vi.useFakeTimers();
    try {
      const sdk = fakeSdk();
      sdk.machines.get.mockImplementationOnce(() => new Promise(() => {}));
      const { client } = clientWith(sdk);
      const pending = client.getMachine("m-1").catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(16_000);
      expect(await pending).toBeInstanceOf(RequestDeadlineError);
    } finally {
      vi.useRealTimers();
    }
  });

  it("surfaces the caller's abort as BoxdCancelledError", async () => {
    const sdk = fakeSdk();
    sdk.machines.hibernate.mockImplementationOnce(() => new Promise(() => {}));
    const { client } = clientWith(sdk);
    const controller = new AbortController();
    const pending = client.hibernateMachine("m-1", controller.signal);
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(BoxdCancelledError);
  });
});

describe("boxd sizes", () => {
  it("knows the four size classes and their resources", () => {
    expect(isBoxdMachineSize("4x16")).toBe(true);
    expect(isBoxdMachineSize("3x12")).toBe(false);
    expect(boxdSizeResources("8x32")).toEqual({ vcpu: 8, memoryGib: 32 });
  });
});

describe("delayUnlessCancelled", () => {
  it("rejects at once on an aborted signal and on abort while waiting", async () => {
    await expect(delayUnlessCancelled(10, AbortSignal.abort())).rejects.toBeInstanceOf(
      BoxdCancelledError
    );
    const controller = new AbortController();
    const pending = delayUnlessCancelled(10_000, controller.signal);
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(BoxdCancelledError);
  });

  it("resolves after the delay without a signal", async () => {
    await expect(delayUnlessCancelled(1)).resolves.toBeUndefined();
  });
});
