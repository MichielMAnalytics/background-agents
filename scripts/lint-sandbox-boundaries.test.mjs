import assert from "node:assert/strict";
import test from "node:test";
import { lintText } from "./oxlint/lint-text.mjs";

test("new consumers and platform adapters cannot import sandbox implementations", async () => {
  for (const filePath of [
    "packages/control-plane/src/session/new-consumer.ts",
    "packages/control-plane/src/node/new-consumer.ts",
    "packages/control-plane/src/node/host.ts",
    "packages/control-plane/src/cloudflare/durable-object.ts",
    "packages/control-plane/src/index.ts",
  ]) {
    for (const [name, source] of [
      ["SandboxRepository", "../session/sandbox-repository"],
      ["SandboxLifecycleManager", "../sandbox/lifecycle/manager"],
      ["SandboxLaunchContext", "../sandbox/lifecycle/launch-context"],
      ["SandboxAccess", "../sandbox/lifecycle/sandbox-access"],
      ["VmStartupReconciliation", "../sandbox/lifecycle/vm-startup-reconciliation"],
      ["AllocationCleanupDependencies", "../sandbox/lifecycle/allocation-cleanup"],
      ["ProviderStopOutcome", "../sandbox/lifecycle/provider-stop"],
      ["SpawnSupersededError", "../sandbox/lifecycle/startup-errors"],
      ["WatchdogEffectsDependencies", "../sandbox/lifecycle/watchdog-effects"],
    ]) {
      for (const specifier of [source, `${source}.ts`]) {
        const result = await lintText(
          `import type { ${name} } from "${specifier}"; export type Dependency = ${name};`,
          filePath
        );
        assert.ok(
          result.messages.some((message) => message.ruleId === "no-restricted-imports"),
          `${filePath} must reject ${specifier}`
        );
      }
    }
  }
});

test("focused ports remain usable by consumers and extracted lifecycle modules", async () => {
  for (const filePath of [
    "packages/control-plane/src/session/new-consumer.ts",
    "packages/control-plane/src/sandbox/lifecycle/readiness.ts",
  ]) {
    const result = await lintText(
      'import type { SandboxReadiness } from "../sandbox/lifecycle/ports"; export type Dependency = SandboxReadiness;',
      filePath
    );
    assert.equal(result.errorCount, 0, JSON.stringify(result.messages));
  }
  const access = await lintText(
    'import type { SandboxAccess } from "./sandbox-access"; export type Dependency = SandboxAccess;',
    "packages/control-plane/src/sandbox/lifecycle/reconciliation.ts"
  );
  assert.equal(access.errorCount, 0, JSON.stringify(access.messages));
  const reconciliation = await lintText(
    'import type { VmStartupReconciliation } from "./vm-startup-reconciliation"; export type Dependency = VmStartupReconciliation;',
    "packages/control-plane/src/sandbox/lifecycle/manager.ts"
  );
  assert.equal(reconciliation.errorCount, 0, JSON.stringify(reconciliation.messages));
  const cleanup = await lintText(
    'import { attemptRejectedStartupCleanup } from "./allocation-cleanup"; export const cleanup = attemptRejectedStartupCleanup;',
    "packages/control-plane/src/sandbox/lifecycle/manager.ts"
  );
  assert.equal(cleanup.errorCount, 0, JSON.stringify(cleanup.messages));
  const watchdog = await lintText(
    'import { terminateStaleHeartbeat } from "./watchdog-effects"; export const effect = terminateStaleHeartbeat;',
    "packages/control-plane/src/sandbox/lifecycle/manager.ts"
  );
  assert.equal(watchdog.errorCount, 0, JSON.stringify(watchdog.messages));
  const launch = await lintText(
    'import { SandboxLaunchContext } from "./launch-context"; export const launch = SandboxLaunchContext;',
    "packages/control-plane/src/sandbox/lifecycle/manager.ts"
  );
  assert.equal(launch.errorCount, 0, JSON.stringify(launch.messages));
  const errors = await lintText(
    'import { SpawnSupersededError } from "./startup-errors"; export const superseded = SpawnSupersededError;',
    "packages/control-plane/src/sandbox/lifecycle/vm-startup-reconciliation.ts"
  );
  assert.equal(errors.errorCount, 0, JSON.stringify(errors.messages));
});
