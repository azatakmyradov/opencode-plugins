import type { McpServerState } from "./rpc.ts";

export interface ServerOption {
  title: string;
  value: string;
  description: string;
}

export function statusLabel(status: string): string {
  switch (status) {
    case "connected":
      return "connected";
    case "failed":
      return "connection failed";
    case "needs_auth":
      return "authentication required";
    case "disabled":
      return "not connected";
    default:
      return status.replaceAll("_", " ");
  }
}

export function serverOption(server: McpServerState): ServerOption {
  const desired = server.enabled ? "enabled" : "disabled";
  const source = server.override ? `override: ${server.override}` : "inherited";
  return {
    title: server.name,
    value: server.name,
    description: `${desired} | ${statusLabel(server.status)} | ${source}`,
  };
}

export function resolveServer(
  input: string | undefined,
  servers: readonly McpServerState[],
): McpServerState | undefined {
  const name = input?.trim();
  if (!name) return;

  const exact = servers.find((server) => server.name === name);
  if (exact) return exact;

  const matches = servers.filter((server) => server.name.toLowerCase() === name.toLowerCase());
  return matches.length === 1 ? matches[0] : undefined;
}
