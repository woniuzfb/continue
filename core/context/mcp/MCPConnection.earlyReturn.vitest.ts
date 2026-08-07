import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock factories are hoisted above imports, so they must not reference
// top-level bindings — define the mock classes inline (vi is available
// inside factories). Tests assert via the instance's own mocks.
vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class {
    constructor(
      public info: any,
      public options: any,
    ) {}
    close = vi.fn().mockResolvedValue(undefined);
    connect = vi.fn().mockResolvedValue(undefined);
    listTools = vi.fn().mockResolvedValue({ tools: [] });
    listPrompts = vi.fn().mockResolvedValue({ prompts: [] });
    listResources = vi.fn().mockResolvedValue({ resources: [] });
    listResourceTemplates = vi.fn().mockResolvedValue({
      resourceTemplates: [],
    });
    getServerCapabilities = vi.fn().mockResolvedValue({});
  },
}));

vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: class {
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;
    close = vi.fn().mockResolvedValue(undefined);
    start = vi.fn().mockResolvedValue(undefined);
    send = vi.fn().mockResolvedValue(undefined);
  },
}));

vi.mock("@modelcontextprotocol/sdk/client/sse.js", () => ({
  SSEClientTransport: class {},
  SseError: class extends Error {},
}));

vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: class {},
}));

vi.mock("@modelcontextprotocol/sdk/client/websocket.js", () => ({
  WebSocketClientTransport: class {},
}));

vi.mock("./MCPOauth", () => ({
  getOauthToken: vi.fn().mockResolvedValue(undefined),
}));

import MCPConnection from "./MCPConnection";

function makeConnection(initialStatus: string): MCPConnection {
  const conn = new MCPConnection(
    {
      name: "test-server",
      type: "stdio",
      command: "echo",
      args: [],
      timeout: 1000,
    } as any,
    undefined,
  );
  (conn as any).status = initialStatus;
  return conn;
}

describe("MCPConnection.connectClient early-return logic", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("non-force call on a healthy connection returns immediately (no rebuild)", async () => {
    const conn = makeConnection("connected");
    await conn.connectClient(false, new AbortController().signal);
    const client = (conn as any).client;
    expect(client.close).not.toHaveBeenCalled();
    expect(client.connect).not.toHaveBeenCalled();
    expect((conn as any).status).toBe("connected");
  });

  it("forceRefresh on a healthy connection actually rebuilds (Reload button)", async () => {
    const conn = makeConnection("connected");
    const oldClient = (conn as any).client;
    await conn.connectClient(true, new AbortController().signal);
    // Old client is closed and replaced by a fresh one that reconnects
    expect(oldClient.close).toHaveBeenCalled();
    expect((conn as any).client).not.toBe(oldClient);
    expect((conn as any).client.connect).toHaveBeenCalled();
    expect((conn as any).status).toBe("connected");
  });

  it("reconnect path (not-connected) still works — used by pre-tool-call auto reconnect", async () => {
    const conn = makeConnection("not-connected");
    await conn.connectClient(true, new AbortController().signal);
    expect((conn as any).client.connect).toHaveBeenCalled();
    expect((conn as any).status).toBe("connected");
  });

  it("forceRefresh while another connect is in flight does not destroy the fresh connection", async () => {
    const conn = makeConnection("not-connected");
    // Delay the first connect() so the second caller arrives mid-flight.
    let release!: (v: unknown) => void;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    (conn as any).client.connect.mockReturnValueOnce(
      gate.then(() => undefined) as unknown as Promise<void>,
    );
    const first = conn.connectClient(false, new AbortController().signal);
    await new Promise((r) => setTimeout(r, 10)); // let connectionPromise get set
    const second = conn.connectClient(true, new AbortController().signal);
    release(undefined);
    await Promise.all([first, second]);
    // The force caller waited for the in-flight connect and did not destroy
    // the connection the first caller established.
    expect((conn as any).status).toBe("connected");
    expect((conn as any).client.connect).toHaveBeenCalledTimes(1);
    expect((conn as any).client.close).not.toHaveBeenCalled();
  });
});
