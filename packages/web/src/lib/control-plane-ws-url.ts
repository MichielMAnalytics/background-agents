/** The control plane's public WebSocket URL, which Next.js inlines into the client bundle. */
export const CONTROL_PLANE_WS_URL = process.env.NEXT_PUBLIC_WS_URL || "ws://localhost:8787";
