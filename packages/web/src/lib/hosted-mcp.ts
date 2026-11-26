/**
 * The hosted MCP server's URL, derived from the control plane's public WebSocket URL: the same
 * host, over HTTP(S), at `/mcp`. Null when the configured URL cannot be parsed.
 */
export function hostedMcpUrl(webSocketUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(webSocketUrl);
  } catch {
    return null;
  }
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  return `${url.origin}/mcp`;
}
