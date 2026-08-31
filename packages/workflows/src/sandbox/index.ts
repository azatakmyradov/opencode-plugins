import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { jsonValueSchema, type JsonValue } from "../core/json.ts";
import { safeStringify, toSerializable } from "../core/serialization.ts";

const MAX_SOURCE_BYTES = 512 * 1024;
const MAX_ARGS_BYTES = 256 * 1024;
const MAX_RESULT_BYTES = 1024 * 1024;
const MAX_AGENT_MESSAGE_BYTES = 512 * 1024;
const MAX_AGENT_REQUESTS = 32;

export const SANDBOX_PING_INTERVAL_MS = 5_000;
export const SANDBOX_PING_MISS_LIMIT = 3;

/**
 * The `agent()` overrides a workflow script may pass. Members the script sends
 * in another form decode to `undefined` for the ones only read when usable, and
 * to `null` for the ones whose mere presence is an instruction to the runner.
 */
const sandboxAgentOptionsSchema = z.object({
  label: z.string().optional().catch(undefined),
  phase: z.string().optional().catch(undefined),
  schema: jsonValueSchema.optional().catch(undefined),
  model: z.string().nullish().catch(null),
  provider: z.string().nullish().catch(null),
  effort: z.string().nullish().catch(null),
});

export type SandboxAgentOptions = z.infer<typeof sandboxAgentOptionsSchema>;

export interface SandboxAgentResult {
  ok: boolean;
  output: string;
  structured?: JsonValue;
  error?: string;
}

export interface RunWorkflowSandboxOptions {
  source: string;
  args: unknown;
  cwd: string;
  /**
   * Absolute path to a Node runtime that supports `--permission`, resolved by
   * `node-runtime.ts`. The sandbox never discovers a runtime itself.
   */
  nodePath: string;
  signal: AbortSignal;
  onAgent: (
    prompt: string,
    options: SandboxAgentOptions,
    signal: AbortSignal,
  ) => Promise<SandboxAgentResult>;
  onPhase: (title: string) => void;
  /** Test-only override for the sandbox liveness ping interval. */
  pingIntervalMs?: number;
  /** Test-only override for consecutive missed pongs tolerated. */
  pingMissLimit?: number;
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

/** The authenticated envelope every child message carries. */
const childEnvelopeSchema = z.object({ token: z.string(), kind: z.string() });
const jsonPayloadSchema = z.object({ payloadJson: z.string() });
const resultPayloadSchema = z.object({ resultJson: z.string() });
const errorPayloadSchema = z.object({ error: z.string() });
const phaseRequestSchema = z.object({ title: z.string() });
const pongSchema = z.object({ seq: z.number().int().min(1) });
const agentRequestSchema = z.object({
  id: z.number().int().min(1),
  prompt: z.string().max(100_000),
  options: sandboxAgentOptionsSchema,
});

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

let cachedChildSource: string | undefined;

/**
 * The child program, evaluated by the sandbox process through `node -e` so the
 * permission-restricted child needs no filesystem read access at all. Sources
 * are read once by the host, which does have filesystem access: `./child.cjs`
 * next to this module in source form, `./sandbox/child.cjs` once bundled.
 */
function loadChildSource(): string {
  if (cachedChildSource !== undefined) return cachedChildSource;
  const candidates = [
    new URL("./child.cjs", import.meta.url),
    new URL("./sandbox/child.cjs", import.meta.url),
  ];
  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      const source = readFileSync(candidate, "utf8");
      cachedChildSource = source;
      return source;
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`Workflow sandbox child source is unavailable: ${errorText(lastError)}`);
}

function terminateChild(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const force = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }, 1_000);
  force.unref?.();
}

/**
 * Execute orchestration code in a separate, permission-restricted Node process.
 * The child can only invoke the narrow agent/phase IPC protocol and is always
 * terminated on completion, cancellation, or protocol failure. The workflow
 * itself and its agent requests have no wall-clock deadline, but the child must
 * keep its event loop responsive; sustained synchronous execution (~15s) is
 * treated as a hang and killed. Active requests are aborted only when the
 * workflow is cancelled or the sandbox is cleaned up.
 */
export function runWorkflowSandbox(options: RunWorkflowSandboxOptions): Promise<JsonValue> {
  if (!options.nodePath) {
    return Promise.reject(
      new Error("No Node runtime able to enforce workflow child permissions was supplied"),
    );
  }
  if (byteLength(options.source) > MAX_SOURCE_BYTES) {
    return Promise.reject(new Error(`Workflow script exceeds the ${MAX_SOURCE_BYTES} byte limit`));
  }

  let childSource: string;
  try {
    childSource = loadChildSource();
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error(errorText(error)));
  }

  const argsJson = safeStringify(
    { defined: options.args !== undefined, value: options.args },
    { maxBytes: MAX_ARGS_BYTES, maxDepth: 16, maxNodes: 10_000 },
  );
  if (byteLength(argsJson) > MAX_ARGS_BYTES) {
    return Promise.reject(new Error("Workflow args exceed the IPC limit"));
  }

  return new Promise<JsonValue>((resolve, reject) => {
    const child = spawn(
      options.nodePath,
      ["--permission", "--max-old-space-size=128", "--stack-size=2048", "-e", childSource],
      {
        cwd: options.cwd,
        env: {
          PATH: process.env.PATH ?? "",
          NODE_NO_WARNINGS: "1",
        },
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      },
    );
    const token = randomBytes(24).toString("hex");
    const requestIds = new Set<number>();
    const activeAgentRequests = new Map<number, AbortController>();
    const pingIntervalMs = options.pingIntervalMs ?? SANDBOX_PING_INTERVAL_MS;
    const pingMissLimit = options.pingMissLimit ?? SANDBOX_PING_MISS_LIMIT;
    let pingSeq = 0;
    let lastPongSeq = 0;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let requestCount = 0;
    let finished = false;

    const cleanup = () => {
      if (heartbeat) clearInterval(heartbeat);
      for (const abortController of activeAgentRequests.values()) {
        abortController.abort(new Error("Workflow stopped"));
      }
      activeAgentRequests.clear();
      options.signal.removeEventListener("abort", onAbort);
      child.removeAllListeners("message");
      child.removeAllListeners("error");
      child.removeAllListeners("exit");
      terminateChild(child);
    };
    const finish = (error?: Error, value: JsonValue = null) => {
      if (finished) return;
      finished = true;
      cleanup();
      if (error) reject(error);
      else resolve(value);
    };
    const onAbort = () => finish(new Error("Workflow was aborted"));

    options.signal.addEventListener("abort", onAbort, { once: true });
    if (options.signal.aborted) {
      onAbort();
      return;
    }

    child.on("error", (error) => finish(error));
    child.on("exit", (code, exitSignal) => {
      if (finished) return;
      finish(
        new Error(`Workflow sandbox exited before completion (${exitSignal ?? code ?? "unknown"})`),
      );
    });
    child.on("message", (raw) => {
      const envelope = childEnvelopeSchema.safeParse(raw);
      if (!envelope.success || envelope.data.token !== token) {
        finish(new Error("Workflow sandbox sent an invalid IPC message"));
        return;
      }
      const kind = envelope.data.kind;
      if (kind === "phase") {
        const message = jsonPayloadSchema.safeParse(raw);
        if (!message.success || message.data.payloadJson.length > 4096) {
          finish(new Error("Workflow sandbox sent an invalid phase update"));
          return;
        }
        try {
          const request = phaseRequestSchema.parse(JSON.parse(message.data.payloadJson));
          options.onPhase(request.title.slice(0, 160));
        } catch {
          finish(new Error("Workflow sandbox sent an invalid phase update"));
        }
        return;
      }
      if (kind === "agent") {
        const message = jsonPayloadSchema.safeParse(raw);
        if (!message.success || byteLength(message.data.payloadJson) > MAX_AGENT_MESSAGE_BYTES) {
          finish(new Error("Workflow sandbox sent an oversized agent request"));
          return;
        }
        let decoded: JsonValue;
        try {
          decoded = jsonValueSchema.parse(JSON.parse(message.data.payloadJson));
        } catch {
          finish(new Error("Workflow sandbox sent malformed agent JSON"));
          return;
        }
        const request = agentRequestSchema.safeParse(decoded);
        if (!request.success) {
          finish(new Error("Workflow sandbox sent an invalid agent request"));
          return;
        }
        const payload = request.data;
        if (requestIds.has(payload.id) || ++requestCount > MAX_AGENT_REQUESTS) {
          finish(new Error("Workflow sandbox exceeded its agent request budget"));
          return;
        }
        requestIds.add(payload.id);
        const id = payload.id;
        const abortController = new AbortController();
        const sendResult = (result: SandboxAgentResult) => {
          if (!activeAgentRequests.delete(id)) return;
          if (finished || !child.connected) return;
          const normalized = toSerializable(result, {
            maxDepth: 16,
            maxNodes: 10_000,
            maxStringBytes: 128 * 1024,
          });
          let resultJson = JSON.stringify(normalized);
          if (byteLength(resultJson) > MAX_AGENT_MESSAGE_BYTES) {
            resultJson = JSON.stringify({
              ok: false,
              output: "",
              error: "Agent result exceeded the workflow IPC output limit",
            });
          }
          child.send({ token, kind: "agentResult", id, resultJson });
        };
        activeAgentRequests.set(id, abortController);
        void options
          .onAgent(payload.prompt, payload.options, abortController.signal)
          .then(sendResult)
          .catch((error) => sendResult({ ok: false, output: "", error: errorText(error) }));
        return;
      }
      if (kind === "pong") {
        const message = pongSchema.safeParse(raw);
        if (!message.success) {
          finish(new Error("Workflow sandbox sent an invalid pong"));
          return;
        }
        lastPongSeq = Math.max(lastPongSeq, message.data.seq);
        return;
      }
      if (kind === "result") {
        const message = resultPayloadSchema.safeParse(raw);
        if (!message.success || byteLength(message.data.resultJson) > MAX_RESULT_BYTES) {
          finish(new Error("Workflow result exceeded the IPC limit"));
          return;
        }
        try {
          const normalized = toSerializable(JSON.parse(message.data.resultJson));
          // Drop the null prototypes `toSerializable` builds so the result is a
          // plain JSON tree for every consumer.
          finish(undefined, jsonValueSchema.parse(JSON.parse(JSON.stringify(normalized))));
        } catch (error) {
          finish(new Error(`Workflow returned invalid JSON: ${errorText(error)}`));
        }
        return;
      }
      if (kind === "error") {
        const message = errorPayloadSchema.safeParse(raw);
        if (message.success) {
          finish(new Error(message.data.error.slice(0, 16 * 1024)));
          return;
        }
      }
      finish(new Error("Workflow sandbox sent an unknown IPC message"));
    });

    child.send(
      {
        kind: "init",
        token,
        source: options.source,
        argsJson,
      },
      (error) => {
        if (error) {
          finish(error);
          return;
        }
        if (finished) return;
        heartbeat = setInterval(() => {
          if (pingSeq - lastPongSeq >= pingMissLimit) {
            const blockedSeconds = (pingIntervalMs * pingMissLimit) / 1_000;
            finish(
              new Error(
                `Workflow script blocked the sandbox event loop for over ${blockedSeconds}s (e.g. an infinite loop after an await); the run was terminated`,
              ),
            );
            return;
          }
          pingSeq++;
          child.send({ kind: "ping", token, seq: pingSeq }, () => {});
        }, pingIntervalMs);
        heartbeat.unref?.();
      },
    );
  });
}
