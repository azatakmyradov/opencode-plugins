import { describe, expect, it } from "vite-plus/test";
import type { McpServerState } from "../src/rpc.ts";
import { resolveServer, serverOption, statusLabel } from "../src/presentation.ts";

const servers: McpServerState[] = [
  {
    name: "Docs",
    enabled: true,
    configuredEnabled: false,
    override: "enabled",
    status: "needs_auth",
    error: null,
  },
  {
    name: "local",
    enabled: false,
    configuredEnabled: false,
    override: null,
    status: "disabled",
    error: null,
  },
];

describe("selector presentation", () => {
  it("formats desired state, runtime status, and override source", () => {
    expect(serverOption(servers[0]!)).toEqual({
      title: "Docs",
      value: "Docs",
      description: "enabled | authentication required | override: enabled",
    });
    expect(serverOption(servers[1]!).description).toBe("disabled | not connected | inherited");
    expect(statusLabel("connection_error")).toBe("connection error");
  });

  it("resolves trimmed exact and unambiguous case-insensitive names", () => {
    expect(resolveServer(" local ", servers)?.name).toBe("local");
    expect(resolveServer("docs", servers)?.name).toBe("Docs");
    expect(resolveServer("missing", servers)).toBeUndefined();
    expect(resolveServer(undefined, servers)).toBeUndefined();
  });
});
