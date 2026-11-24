import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SlackRoutingRule } from "@open-inspect/shared/types/integrations";
import type { Env } from "../types";
import { getRoutingRules } from "./repos";
import { resolveRoutingRuleTargets } from "./routing";

vi.mock("./repos", () => ({ getRoutingRules: vi.fn() }));

describe("repository-less routing rules", () => {
  beforeEach(() => vi.clearAllMocks());

  it("routes a keyword to an empty sandbox without catalog entries", async () => {
    vi.mocked(getRoutingRules).mockResolvedValue([
      { keyword: "notion", target: "none", targetType: "none" },
    ]);
    expect(
      await resolveRoutingRuleTargets({} as Env, "Crée une tâche Notion", {
        repos: [],
        environments: [],
      })
    ).toEqual([{ target: { kind: "none" }, keyword: "notion" }]);
  });

  it("deduplicates keywords that select the same empty sandbox", async () => {
    const rules: SlackRoutingRule[] = [
      { keyword: "notion", target: "none", targetType: "none" },
      { keyword: "task", target: "none", targetType: "none" },
    ];
    vi.mocked(getRoutingRules).mockResolvedValue(rules);
    expect(
      await resolveRoutingRuleTargets({} as Env, "notion task", { repos: [], environments: [] })
    ).toHaveLength(1);
  });

  it("does not treat a legacy repository target as a no-repository rule", async () => {
    vi.mocked(getRoutingRules).mockResolvedValue([{ keyword: "notion", target: "none" }]);
    expect(
      await resolveRoutingRuleTargets({} as Env, "notion", { repos: [], environments: [] })
    ).toEqual([]);
  });
});
