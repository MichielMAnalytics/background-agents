import { describe, expect, it } from "vitest";
import { createTestEnv } from "../router.test-support";
import type { Env } from "../types";
import { createSandboxProviderFromEnv, parseBoxdLabels } from "./provider-factory";

function createEnv(overrides: Partial<Env>): Env {
  return createTestEnv({ TOKEN_ENCRYPTION_KEY: "test-token-key", ...overrides });
}

describe("createSandboxProviderFromEnv", () => {
  it("rejects malformed Vercel numeric configuration", () => {
    const env = createEnv({
      VERCEL_TOKEN: "vercel-token",
      VERCEL_PROJECT_ID: "project-id",
      VERCEL_SNAPSHOT_EXPIRATION_MS: "10m",
    });

    expect(() => createSandboxProviderFromEnv(env, "vercel")).toThrow(
      "VERCEL_SNAPSHOT_EXPIRATION_MS must be a valid number"
    );
  });

  it("rejects malformed Daytona auto-stop configuration", () => {
    const env = createEnv({
      DAYTONA_API_URL: "https://daytona.test",
      DAYTONA_API_KEY: "daytona-key",
      DAYTONA_BASE_SNAPSHOT: "base",
      DAYTONA_AUTO_STOP_INTERVAL_MINUTES: "abc",
    });

    expect(() => createSandboxProviderFromEnv(env, "daytona")).toThrow(
      "DAYTONA_AUTO_STOP_INTERVAL_MINUTES must be a valid number"
    );
  });

  it("rejects malformed Daytona auto-archive configuration", () => {
    const env = createEnv({
      DAYTONA_API_URL: "https://daytona.test",
      DAYTONA_API_KEY: "daytona-key",
      DAYTONA_BASE_SNAPSHOT: "base",
      DAYTONA_AUTO_STOP_INTERVAL_MINUTES: "30",
      DAYTONA_AUTO_ARCHIVE_INTERVAL_MINUTES: "abc",
    });

    expect(() => createSandboxProviderFromEnv(env, "daytona")).toThrow(
      "DAYTONA_AUTO_ARCHIVE_INTERVAL_MINUTES must be a valid number"
    );
  });

  it("needs a base snapshot to create Daytona sandboxes", () => {
    const env = createEnv({
      DAYTONA_API_URL: "https://daytona.test",
      DAYTONA_API_KEY: "daytona-key",
    });

    expect(() => createSandboxProviderFromEnv(env, "daytona")).toThrow(
      "DAYTONA_BASE_SNAPSHOT is required to create Daytona sandboxes"
    );
  });

  it("still requires Daytona credentials", () => {
    expect(() =>
      createSandboxProviderFromEnv(
        createEnv({ DAYTONA_API_URL: "https://daytona.test" }),
        "daytona"
      )
    ).toThrow("DAYTONA_API_URL and DAYTONA_API_KEY are required");
  });

  it("requires Boat credentials and a base snapshot", () => {
    expect(() =>
      createSandboxProviderFromEnv(createEnv({ BOAT_API_KEY: "boat_key" }), "boat")
    ).toThrow("BOAT_API_KEY and BOAT_BASE_SNAPSHOT are required");
    expect(() =>
      createSandboxProviderFromEnv(createEnv({ BOAT_BASE_SNAPSHOT: "open-inspect-abc" }), "boat")
    ).toThrow("BOAT_API_KEY and BOAT_BASE_SNAPSHOT are required");
  });

  it("rejects an unknown Boat machine type", () => {
    const env = createEnv({
      BOAT_API_KEY: "boat_key",
      BOAT_BASE_SNAPSHOT: "open-inspect-abc",
      BOAT_SANDBOX_TYPE: "huge",
    });

    expect(() => createSandboxProviderFromEnv(env, "boat")).toThrow(
      "BOAT_SANDBOX_TYPE must be one of small, default, large, xlarge"
    );
  });

  it("builds the Boat provider from its environment", () => {
    const provider = createSandboxProviderFromEnv(
      createEnv({ BOAT_API_KEY: "boat_key", BOAT_BASE_SNAPSHOT: "open-inspect-abc" }),
      "boat"
    );
    expect(provider.name).toBe("boat");
    expect(provider.capabilities).toMatchObject({
      supportsPersistentResume: true,
      supportsExplicitStop: true,
      supportsSnapshots: false,
    });
  });

  it("requires boxd credentials and a base snapshot", () => {
    expect(() =>
      createSandboxProviderFromEnv(createEnv({ BOXD_API_KEY: "test-boxd-key" }), "boxd")
    ).toThrow("BOXD_API_KEY and BOXD_BASE_SNAPSHOT are required");
    expect(() =>
      createSandboxProviderFromEnv(createEnv({ BOXD_BASE_SNAPSHOT: "open-inspect-abc" }), "boxd")
    ).toThrow("BOXD_API_KEY and BOXD_BASE_SNAPSHOT are required");
  });

  it("rejects an unknown boxd machine size", () => {
    const env = createEnv({
      BOXD_API_KEY: "test-boxd-key",
      BOXD_BASE_SNAPSHOT: "open-inspect-abc",
      BOXD_SANDBOX_SIZE: "3x12",
    });

    expect(() => createSandboxProviderFromEnv(env, "boxd")).toThrow(
      "BOXD_SANDBOX_SIZE must be one of 1x4, 2x8, 4x16, 8x32"
    );
  });

  it("parses extra boxd machine labels and refuses a malformed pair", () => {
    expect(parseBoxdLabels(" team=platform, overnight = yes ,")).toEqual({
      team: "platform",
      overnight: "yes",
    });
    expect(parseBoxdLabels(undefined)).toEqual({});
    expect(() => parseBoxdLabels("novalue")).toThrow("BOXD_LABELS must be");
    expect(() =>
      createSandboxProviderFromEnv(
        createEnv({ BOXD_API_KEY: "k", BOXD_BASE_SNAPSHOT: "s", BOXD_LABELS: "=x" }),
        "boxd"
      )
    ).toThrow("BOXD_LABELS must be");
  });

  it("builds the boxd provider from its environment", () => {
    const provider = createSandboxProviderFromEnv(
      createEnv({
        BOXD_API_KEY: "test-boxd-key",
        BOXD_BASE_SNAPSHOT: "open-inspect-abc",
        BOXD_REGION: "fra",
        BOXD_ORG: "acme",
      }),
      "boxd"
    );
    expect(provider.name).toBe("boxd");
    expect(provider.capabilities).toMatchObject({
      supportsPersistentResume: true,
      supportsExplicitStop: true,
      supportsSnapshots: false,
      supportsSandboxTimeout: false,
    });
  });

  it("rejects malformed E2B auto-pause configuration", () => {
    const env = createEnv({
      E2B_API_KEY: "e2b-key",
      E2B_TEMPLATE_ID: "tmpl",
      E2B_AUTO_PAUSE: "tru",
    });

    expect(() => createSandboxProviderFromEnv(env, "e2b")).toThrow(
      "E2B_AUTO_PAUSE must be a valid boolean"
    );
  });
});
