import { describe, expect, it } from "vitest";
import { hostedMcpUrl } from "./hosted-mcp";

describe("hostedMcpUrl", () => {
  it("is the control plane's own origin at /mcp, over the matching HTTP scheme", () => {
    expect(hostedMcpUrl("wss://cp.example.com")).toBe("https://cp.example.com/mcp");
    expect(hostedMcpUrl("wss://cp.example.com/sessions")).toBe("https://cp.example.com/mcp");
    expect(hostedMcpUrl("ws://localhost:8787")).toBe("http://localhost:8787/mcp");
  });

  it("is null for a URL it cannot parse", () => {
    expect(hostedMcpUrl("not a url")).toBeNull();
  });
});
