import {
  createBoatRestClient,
  DEFAULT_BOAT_API_URL,
  isBoatMachineType,
  type BoatMachineType,
  type BoatRestClient,
} from "./boat-rest-client";
import {
  createBoxdClient,
  isBoxdMachineSize,
  type BoxdClient,
  type BoxdMachineSize,
} from "./boxd-client";
import { createModalClient } from "./client";
import { createDaytonaRestClient, type DaytonaRestClient } from "./daytona-rest-client";
import { createE2BRestClient } from "./e2b-rest-client";
import { resolveSandboxBackendName, type SandboxBackendName } from "./provider-name";
import type { SandboxProvider } from "./provider";
import { createBoatProvider, type BoatSandboxProvider } from "./providers/boat-provider";
import { createBoxdProvider, type BoxdSandboxProvider } from "./providers/boxd-provider";
import { createDaytonaProvider, type DaytonaSandboxProvider } from "./providers/daytona-provider";
import {
  createE2BProvider,
  DEFAULT_E2B_AUTO_PAUSE,
  DEFAULT_E2B_SANDBOX_TIMEOUT_SECONDS,
  type E2BSandboxProvider,
} from "./providers/e2b-provider";
import { createModalProvider, type ModalSandboxProvider } from "./providers/modal-provider";
import { createVercelSandboxClient } from "./providers/vercel/client";
import { createVercelProvider, type VercelSandboxProvider } from "./providers/vercel/provider";
import { resolveScmProviderFromEnv } from "../source-control";
import type { Env } from "../types";

function createModalProviderFromEnv(env: Env, backend: "modal" | "modal-vm"): ModalSandboxProvider {
  if (!env.MODAL_API_SECRET || !env.MODAL_WORKSPACE) {
    throw new Error(
      `MODAL_API_SECRET and MODAL_WORKSPACE are required when SANDBOX_PROVIDER=${backend}`
    );
  }

  const client = createModalClient(
    env.MODAL_API_SECRET,
    env.MODAL_WORKSPACE,
    env.MODAL_ENVIRONMENT_WEB_SUFFIX,
    env.MODAL_API_URL
  );

  return createModalProvider(client, backend, resolveScmProviderFromEnv(env.SCM_PROVIDER));
}

function createVercelProviderFromEnv(env: Env): VercelSandboxProvider {
  if (!env.VERCEL_TOKEN || !env.VERCEL_PROJECT_ID) {
    throw new Error("VERCEL_TOKEN and VERCEL_PROJECT_ID are required when SANDBOX_PROVIDER=vercel");
  }

  const client = createVercelSandboxClient({
    token: env.VERCEL_TOKEN,
    projectId: env.VERCEL_PROJECT_ID,
    teamId: env.VERCEL_TEAM_ID,
    apiBaseUrl: env.VERCEL_SANDBOX_API_BASE_URL,
  });

  return createVercelProvider(client, {
    scmProvider: resolveScmProviderFromEnv(env.SCM_PROVIDER),
    token: env.VERCEL_TOKEN,
    teamId: env.VERCEL_TEAM_ID,
    apiBaseUrl: env.VERCEL_SANDBOX_API_BASE_URL,
    baseSnapshotId: env.VERCEL_BASE_SNAPSHOT_ID,
    baseSnapshotName: env.VERCEL_BASE_SNAPSHOT_NAME,
    runtime: env.VERCEL_RUNTIME,
    snapshotExpirationMs: parseNumericEnv(
      "VERCEL_SNAPSHOT_EXPIRATION_MS",
      env.VERCEL_SNAPSHOT_EXPIRATION_MS,
      0
    ),
    sandboxAccessPasswordSecret: env.VERCEL_TOKEN,
  });
}

/**
 * The Daytona transport for one operation, shared by the session provider and
 * the image-build resources.
 *
 * Only creating a sandbox needs a base image. Finalizing and reclaiming what
 * an earlier configuration created must stay possible after a provider
 * switch, when no Daytona base snapshot is built any more.
 */
export function createDaytonaRestClientFromEnv(
  env: Env,
  options: { requireBaseSnapshot: boolean }
): DaytonaRestClient {
  if (!env.DAYTONA_API_URL || !env.DAYTONA_API_KEY) {
    throw new Error(
      "DAYTONA_API_URL and DAYTONA_API_KEY are required when SANDBOX_PROVIDER=daytona"
    );
  }
  if (options.requireBaseSnapshot && !env.DAYTONA_BASE_SNAPSHOT) {
    throw new Error("DAYTONA_BASE_SNAPSHOT is required to create Daytona sandboxes");
  }

  return createDaytonaRestClient({
    apiUrl: env.DAYTONA_API_URL,
    apiKey: env.DAYTONA_API_KEY,
    target: env.DAYTONA_TARGET,
    baseSnapshot: env.DAYTONA_BASE_SNAPSHOT,
    toolboxApiUrl: env.DAYTONA_TOOLBOX_API_URL,
  });
}

function createDaytonaProviderFromEnv(env: Env): DaytonaSandboxProvider {
  const client = createDaytonaRestClientFromEnv(env, { requireBaseSnapshot: true });

  return createDaytonaProvider(client, {
    scmProvider: resolveScmProviderFromEnv(env.SCM_PROVIDER),
    gitlabAccessToken: env.GITLAB_ACCESS_TOKEN,
    sandboxAccessPasswordSecret: client.config.apiKey,
    autoStopIntervalMinutes: parseNumericEnv(
      "DAYTONA_AUTO_STOP_INTERVAL_MINUTES",
      env.DAYTONA_AUTO_STOP_INTERVAL_MINUTES,
      120
    ),
    autoArchiveIntervalMinutes: parseNumericEnv(
      "DAYTONA_AUTO_ARCHIVE_INTERVAL_MINUTES",
      env.DAYTONA_AUTO_ARCHIVE_INTERVAL_MINUTES,
      10080
    ),
  });
}

function createE2BProviderFromEnv(env: Env): E2BSandboxProvider {
  if (!env.E2B_API_KEY || !env.E2B_TEMPLATE_ID) {
    throw new Error("E2B_API_KEY and E2B_TEMPLATE_ID are required when SANDBOX_PROVIDER=e2b");
  }

  const client = createE2BRestClient({
    apiUrl: env.E2B_API_URL || "https://api.e2b.app",
    apiKey: env.E2B_API_KEY,
    templateId: env.E2B_TEMPLATE_ID,
  });

  return createE2BProvider(client, {
    scmProvider: resolveScmProviderFromEnv(env.SCM_PROVIDER),
    sandboxAccessPasswordSecret: env.E2B_API_KEY,
    sandboxTimeoutSeconds: parseNumericEnv(
      "E2B_SANDBOX_TIMEOUT_SECONDS",
      env.E2B_SANDBOX_TIMEOUT_SECONDS,
      DEFAULT_E2B_SANDBOX_TIMEOUT_SECONDS
    ),
    autoPause: parseBooleanEnv("E2B_AUTO_PAUSE", env.E2B_AUTO_PAUSE, DEFAULT_E2B_AUTO_PAUSE),
  });
}

/**
 * The Boat transport, shared by the session provider and the image-build
 * resources. Only creating a sandbox needs the base snapshot; finalizing and
 * reclaiming what an earlier configuration created must stay possible after
 * a provider switch, when no Boat base snapshot is built any more.
 */
export function createBoatRestClientFromEnv(env: Env): BoatRestClient {
  if (!env.BOAT_API_KEY) {
    throw new Error("BOAT_API_KEY is required when SANDBOX_PROVIDER=boat");
  }
  return createBoatRestClient({
    apiUrl: env.BOAT_API_URL || DEFAULT_BOAT_API_URL,
    apiKey: env.BOAT_API_KEY,
    org: env.BOAT_ORG?.trim() || undefined,
  });
}

/** Machine size for a sandbox whose scope requests no CPU or memory. */
export function resolveBoatDefaultMachineType(env: Env): BoatMachineType {
  const defaultMachineType = env.BOAT_SANDBOX_TYPE?.trim() || "default";
  if (!isBoatMachineType(defaultMachineType)) {
    throw new Error("BOAT_SANDBOX_TYPE must be one of small, default, large, xlarge");
  }
  return defaultMachineType;
}

function createBoatProviderFromEnv(env: Env): BoatSandboxProvider {
  if (!env.BOAT_API_KEY || !env.BOAT_BASE_SNAPSHOT) {
    throw new Error("BOAT_API_KEY and BOAT_BASE_SNAPSHOT are required when SANDBOX_PROVIDER=boat");
  }

  return createBoatProvider(createBoatRestClientFromEnv(env), {
    scmProvider: resolveScmProviderFromEnv(env.SCM_PROVIDER),
    sandboxAccessPasswordSecret: env.BOAT_API_KEY,
    baseSnapshot: env.BOAT_BASE_SNAPSHOT,
    defaultMachineType: resolveBoatDefaultMachineType(env),
    deploymentName: env.DEPLOYMENT_NAME,
  });
}

/** The boxd client for this deployment's key, region and org. */
export function createBoxdClientFromEnv(env: Env): BoxdClient {
  if (!env.BOXD_API_KEY) {
    throw new Error("BOXD_API_KEY is required when SANDBOX_PROVIDER=boxd");
  }
  return createBoxdClient({
    apiKey: env.BOXD_API_KEY,
    region: env.BOXD_REGION?.trim() || undefined,
    org: env.BOXD_ORG?.trim() || undefined,
    baseUrl: env.BOXD_API_URL?.trim() || undefined,
  });
}

/** Default boxd machine size, used when a session requests no CPU or memory. */
export const DEFAULT_BOXD_SANDBOX_SIZE: BoxdMachineSize = "2x8";

/** Machine size for a sandbox whose scope requests no CPU or memory. */
export function resolveBoxdDefaultMachineSize(env: Env): BoxdMachineSize {
  const size = env.BOXD_SANDBOX_SIZE?.trim() || DEFAULT_BOXD_SANDBOX_SIZE;
  if (!isBoxdMachineSize(size)) {
    throw new Error("BOXD_SANDBOX_SIZE must be one of 1x4, 2x8, 4x16, 8x32");
  }
  return size;
}

/**
 * Extra labels for every boxd machine, from `BOXD_LABELS` as comma-separated
 * `key=value` pairs. boxd validates keys and values on create; this only
 * refuses what is not a pair at all.
 */
export function parseBoxdLabels(value: string | undefined): Record<string, string> {
  const labels: Record<string, string> = {};
  for (const entry of (value ?? "").split(",")) {
    const pair = entry.trim();
    if (!pair) continue;
    const separator = pair.indexOf("=");
    if (separator <= 0) {
      throw new Error("BOXD_LABELS must be comma-separated key=value pairs");
    }
    labels[pair.slice(0, separator).trim()] = pair.slice(separator + 1).trim();
  }
  return labels;
}

function createBoxdProviderFromEnv(env: Env): BoxdSandboxProvider {
  if (!env.BOXD_API_KEY || !env.BOXD_BASE_SNAPSHOT) {
    throw new Error("BOXD_API_KEY and BOXD_BASE_SNAPSHOT are required when SANDBOX_PROVIDER=boxd");
  }

  return createBoxdProvider(createBoxdClientFromEnv(env), {
    scmProvider: resolveScmProviderFromEnv(env.SCM_PROVIDER),
    sandboxAccessPasswordSecret: env.BOXD_API_KEY,
    baseSnapshot: env.BOXD_BASE_SNAPSHOT,
    defaultSize: resolveBoxdDefaultMachineSize(env),
    deploymentName: env.DEPLOYMENT_NAME,
    extraLabels: parseBoxdLabels(env.BOXD_LABELS),
  });
}

export function createSandboxProviderFromEnv(env: Env, backend: "boat"): BoatSandboxProvider;
export function createSandboxProviderFromEnv(env: Env, backend: "boxd"): BoxdSandboxProvider;
export function createSandboxProviderFromEnv(env: Env, backend: "daytona"): DaytonaSandboxProvider;
export function createSandboxProviderFromEnv(env: Env, backend: "e2b"): E2BSandboxProvider;
export function createSandboxProviderFromEnv(
  env: Env,
  backend: "modal" | "modal-vm"
): ModalSandboxProvider;
export function createSandboxProviderFromEnv(env: Env, backend: "vercel"): VercelSandboxProvider;
export function createSandboxProviderFromEnv(
  env: Env,
  backend?: SandboxBackendName
): SandboxProvider;
export function createSandboxProviderFromEnv(
  env: Env,
  backend: SandboxBackendName = resolveSandboxBackendName(env.SANDBOX_PROVIDER)
): SandboxProvider {
  switch (backend) {
    case "boat":
      return createBoatProviderFromEnv(env);
    case "boxd":
      return createBoxdProviderFromEnv(env);
    case "daytona":
      return createDaytonaProviderFromEnv(env);
    case "vercel":
      return createVercelProviderFromEnv(env);
    case "e2b":
      return createE2BProviderFromEnv(env);
    case "modal":
    case "modal-vm":
      return createModalProviderFromEnv(env, backend);
  }
}

function parseNumericEnv(name: string, value: string | undefined, defaultValue: number): number {
  const raw = value?.trim();
  if (!raw) return defaultValue;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${name} must be a valid number`);
  }
  return parsed;
}

function parseBooleanEnv(name: string, value: string | undefined, defaultValue: boolean): boolean {
  const raw = value?.trim().toLowerCase();
  if (!raw) return defaultValue;
  if (raw === "true" || raw === "1") return true;
  if (raw === "false" || raw === "0") return false;
  throw new Error(`${name} must be a valid boolean`);
}
