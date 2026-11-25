import { describe, expect, it } from "vitest";
import { lintText } from "../../../../scripts/oxlint/lint-text.mjs";

const resourceRoutePath = "packages/web/src/app/api/example/route.ts";
const authRoutePath = "packages/web/src/app/api/auth/example/route.ts";

async function restrictedImportMessages(source: string, filePath = resourceRoutePath) {
  const result = await lintText(source, filePath);
  return result.messages.filter((message) => message.ruleId === "no-restricted-imports");
}

describe("server authentication import boundary", () => {
  it.each([
    {
      description: "the authentication framework module",
      source: 'import NextAuth from "next-auth";',
    },
    {
      description: "the aliased auth implementation",
      source: 'import { authOptions } from "@/lib/auth";',
    },
    {
      description: "a relative path to the auth implementation",
      source: 'import { authOptions } from "../../../lib/auth";',
    },
  ])("rejects $description", async ({ source }) => {
    await expect(restrictedImportMessages(source)).resolves.toHaveLength(1);
  });

  it("allows resource routes to import the server-auth seam", async () => {
    await expect(
      restrictedImportMessages('import { getServerAuthSession } from "@/lib/server-auth-session";')
    ).resolves.toHaveLength(0);
  });

  it("rejects framework imports from auth proxy endpoints", async () => {
    await expect(
      restrictedImportMessages('import NextAuth from "next-auth";', authRoutePath)
    ).resolves.toHaveLength(1);
  });
});
