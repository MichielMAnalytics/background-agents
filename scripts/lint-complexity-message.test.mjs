import assert from "node:assert/strict";
import test from "node:test";

import { parseComplexityMessage } from "./lint-complexity-message.mjs";
import { lintText, loadRepositoryConfig } from "./oxlint/lint-text.mjs";

test("parses the supported oxlint complexity diagnostic shape", async () => {
  const config = await loadRepositoryConfig({
    rules: { complexity: ["warn", { max: 0, variant: "classic" }] },
  });
  const { messages } = await lintText(
    "function example(value) { if (value) return 1; return 0; }",
    "example.js",
    { config }
  );
  const [message] = messages;

  assert.equal(messages.length, 1);
  assert.deepEqual(
    { ruleId: message.ruleId, message: message.message },
    {
      ruleId: "complexity",
      message: "function `example` has a complexity of 2. Maximum allowed is 0.",
    }
  );

  assert.deepEqual(parseComplexityMessage("packages/example.ts", message), {
    file: "packages/example.ts",
    line: 1,
    column: 1,
    complexity: 2,
    description: "function `example`",
  });
});

test("rejects an unsupported complexity diagnostic shape", () => {
  assert.throws(
    () =>
      parseComplexityMessage("packages/example.ts", {
        ruleId: "complexity",
        message: "Function 'example' is too complex (12).",
        line: 4,
        column: 1,
      }),
    /Could not parse complexity at packages\/example\.ts:4:1/u
  );
});
