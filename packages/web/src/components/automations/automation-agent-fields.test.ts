import { describe, expect, it } from "vitest";
import { formatTimeBudget } from "./automation-agent-fields";

describe("formatTimeBudget", () => {
  it("labels presets in their natural unit", () => {
    expect(formatTimeBudget(15 * 60_000)).toBe("15 minutes");
    expect(formatTimeBudget(60 * 60_000)).toBe("1 hour");
    expect(formatTimeBudget(24 * 60 * 60_000)).toBe("24 hours");
  });

  it("labels an off-preset override exactly, so it never collides with the preset it is near", () => {
    expect(formatTimeBudget(901_000)).toBe("15 minutes 1 second");
    expect(formatTimeBudget(901_000)).not.toBe(formatTimeBudget(900_000));
    expect(formatTimeBudget(90 * 60_000)).toBe("1 hour 30 minutes");
  });
});
