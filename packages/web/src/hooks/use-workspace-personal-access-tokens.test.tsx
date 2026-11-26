// @vitest-environment jsdom

import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { SWRConfig } from "swr";
import type { WorkspacePersonalAccessToken } from "@open-inspect/shared/types/personal-access-tokens";
import { browserApiFetch } from "@/lib/browser-api-fetch";
import {
  saveWorkspacePersonalAccessTokenPolicy,
  useWorkspacePersonalAccessTokens,
} from "./use-workspace-personal-access-tokens";

let currentUserId = "aaaa1111aaaa1111aaaa1111aaaa1111";

vi.mock("@/lib/auth-session", () => ({
  useAuthSession: () => ({ data: { user: { id: currentUserId } }, status: "authenticated" }),
}));
vi.mock("@/lib/browser-api-fetch", () => ({ browserApiFetch: vi.fn() }));

const TOKEN: WorkspacePersonalAccessToken = {
  id: "token-1",
  name: "CI reader",
  displayPrefix: "oi_pat_a1b2c3",
  permissions: ["sessions.read"],
  createdAt: 1,
  lastUsedAt: null,
  expiresAt: 2,
  owner: { userId: "user-2", displayName: "Ada Member", email: null },
};

afterEach(cleanup);

describe("useWorkspacePersonalAccessTokens", () => {
  beforeEach(() => {
    currentUserId = "aaaa1111aaaa1111aaaa1111aaaa1111";
    vi.mocked(browserApiFetch).mockReset();
  });

  it("never shows one signed-in user's cached inventory to the next", async () => {
    const cache = new Map();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <SWRConfig value={{ provider: () => cache, dedupingInterval: 0 }}>{children}</SWRConfig>
    );
    vi.mocked(browserApiFetch).mockResolvedValueOnce(
      Response.json({ tokens: [TOKEN], nextCursor: null })
    );
    const { result, rerender } = renderHook(() => useWorkspacePersonalAccessTokens(), { wrapper });
    await waitFor(() => expect(result.current.tokens).toEqual([TOKEN]));

    // A different user signs in on the same browser; their own request has not answered yet.
    currentUserId = "bbbb2222bbbb2222bbbb2222bbbb2222";
    vi.mocked(browserApiFetch).mockReturnValue(new Promise<Response>(() => {}));
    rerender();
    expect(result.current.tokens).toEqual([]);
  });

  it("keeps a previous user's late response out of the next user's inventory", async () => {
    const cache = new Map();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <SWRConfig value={{ provider: () => cache, dedupingInterval: 0 }}>{children}</SWRConfig>
    );
    let answerFirstUser!: (response: Response) => void;
    vi.mocked(browserApiFetch).mockReturnValueOnce(
      new Promise<Response>((resolve) => (answerFirstUser = resolve))
    );
    const { result, rerender } = renderHook(() => useWorkspacePersonalAccessTokens(), { wrapper });

    currentUserId = "bbbb2222bbbb2222bbbb2222bbbb2222";
    vi.mocked(browserApiFetch).mockReturnValue(new Promise<Response>(() => {}));
    rerender();
    answerFirstUser(Response.json({ tokens: [TOKEN], nextCursor: null }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(result.current.tokens).toEqual([]);
  });
});

describe("saveWorkspacePersonalAccessTokenPolicy", () => {
  const SNAPSHOT = {
    enabled: true,
    maxLifetimeDays: null,
    allowedPermissions: null,
    revision: 4,
    updatedAt: 1,
    updatedByUserId: null,
  };

  beforeEach(() => vi.mocked(browserApiFetch).mockReset());

  it("reads the policy from a control plane on either side of this app's version", async () => {
    // Older: no MCP switch yet. Newer: a field this app does not know.
    for (const body of [SNAPSHOT, { ...SNAPSHOT, mcpEnabled: false, futureSetting: 1 }]) {
      vi.mocked(browserApiFetch).mockResolvedValueOnce(Response.json(body));
      const result = await saveWorkspacePersonalAccessTokenPolicy(
        { enabled: true, maxLifetimeDays: null, allowedPermissions: null },
        3
      );
      expect(result).toEqual({
        status: "saved",
        policy: { ...SNAPSHOT, ...("mcpEnabled" in body ? { mcpEnabled: false } : {}) },
      });
    }
  });
});
