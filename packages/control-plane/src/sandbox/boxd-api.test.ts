import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as BoxdSdk from "@boxd-sh/sdk/web";

const sdk = vi.hoisted(() => {
  const machines = {
    create: vi.fn(),
    get: vi.fn(),
    exec: vi.fn(),
    waitUntilReady: vi.fn(),
    fs: { write: vi.fn() },
    proxies: { list: vi.fn() },
  };
  const constructed: unknown[] = [];
  return { machines, constructed };
});

vi.mock("@boxd-sh/sdk/web", async (importOriginal) => {
  const actual = await importOriginal<typeof BoxdSdk>();
  class Boxd {
    machines = sdk.machines;
    constructor(options: unknown) {
      sdk.constructed.push(options);
    }
  }
  return { ...actual, Boxd };
});

const { APIConnectionError, AuthenticationError, BoxdError, ConflictError, NotFoundError } =
  await import("@boxd-sh/sdk/web");
const { createBoxdSandboxApi, toBoxdApiError } = await import("./boxd-api");

const MACHINE = { id: "m-1", name: "openinspect-abc", status: "pending", labels: { a: "b" } };

describe("createBoxdSandboxApi", () => {
  beforeEach(() => {
    sdk.constructed.length = 0;
    for (const mock of [
      sdk.machines.create,
      sdk.machines.get,
      sdk.machines.exec,
      sdk.machines.waitUntilReady,
    ]) {
      mock.mockReset();
    }
  });

  it("creates every session machine isolated, from the snapshot, in the configured org", async () => {
    sdk.machines.create.mockResolvedValue(MACHINE);
    const api = createBoxdSandboxApi({ apiKey: "test-api-key", region: "fra", org: "acme" });

    const created = await api.createMachine({
      name: "openinspect-abc",
      fromSnapshot: "openinspect-sandbox-1",
      labels: { a: "b" },
      proxies: [{ name: "code", port: 8080 }],
    });

    expect(sdk.constructed).toEqual([{ apiKey: "test-api-key", region: "fra" }]);
    expect(sdk.machines.create).toHaveBeenCalledWith({
      name: "openinspect-abc",
      fromSnapshot: "openinspect-sandbox-1",
      org: "acme",
      isolated: true,
      labels: { a: "b" },
      config: {
        autoSuspendTimeout: 0,
        idleIgnoreOutbound: false,
        proxies: [{ name: "code", port: 8080 }],
      },
    });
    expect(created).toEqual({
      id: "m-1",
      name: "openinspect-abc",
      status: "pending",
      labels: { a: "b" },
    });
  });

  it("translates SDK errors on the way out", async () => {
    sdk.machines.get.mockRejectedValue(new NotFoundError("machine not found", 5));
    const api = createBoxdSandboxApi({ apiKey: "test-api-key" });

    await expect(api.getMachine("m-1")).rejects.toMatchObject({
      name: "BoxdApiError",
      kind: "not_found",
    });
  });

  it.each([
    "machine m did not reach 'running' within 180000ms",
    "machine m entered terminal state 'stopped' while waiting",
  ])("treats a readiness failure as transient: %s", async (message) => {
    sdk.machines.waitUntilReady.mockRejectedValue(new BoxdError(message));
    const api = createBoxdSandboxApi({ apiKey: "test-api-key" });

    await expect(api.waitUntilReady("m-1", 180_000)).rejects.toMatchObject({
      kind: "server",
      isRetryable: true,
    });
  });

  it("keeps the status of a readiness failure boxd answered", async () => {
    sdk.machines.waitUntilReady.mockRejectedValue(new AuthenticationError("bad key", 16));
    const api = createBoxdSandboxApi({ apiKey: "test-api-key" });

    await expect(api.waitUntilReady("m-1", 1000)).rejects.toMatchObject({
      kind: "authentication",
    });
  });

  it("runs commands with a timeout and returns the exit code", async () => {
    sdk.machines.exec.mockResolvedValue({ exitCode: 3, stdout: "out", stderr: "err" });
    const api = createBoxdSandboxApi({ apiKey: "test-api-key" });

    expect(await api.exec("m-1", "true", 5000)).toEqual({
      exitCode: 3,
      stdout: "out",
      stderr: "err",
    });
    expect(sdk.machines.exec).toHaveBeenCalledWith("m-1", { command: "true", timeout: 5000 });
  });
});

describe("toBoxdApiError", () => {
  it.each([
    [new NotFoundError("gone", 5), "not_found", false],
    [new ConflictError("taken", 6), "conflict", true],
    [new AuthenticationError("bad key", 16), "authentication", false],
    [new APIConnectionError("offline"), "connection", true],
    [new BoxdError("unavailable", 14), "server", true],
    [new BoxdError("bad request", 3), "request", false],
    [new TypeError("fetch failed"), "connection", true],
    [new TypeError("undefined is not a function"), "request", false],
  ])("maps %s", (error, kind, retryable) => {
    const translated = toBoxdApiError(error);
    expect(translated.kind).toBe(kind);
    expect(translated.isRetryable).toBe(retryable);
  });
});
