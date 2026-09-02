"use strict";

// This file is launched by sandbox/index.ts in Node permission mode. It deliberately
// has no filesystem/network/child-process permissions and receives workflow
// source only over a validated IPC channel.
const vm = require("node:vm");
const sendIpc = process.send?.bind(process);
process.on("disconnect", () => {
  process.exit(1);
});
// If a future V8 escape exposes `process`, remove the convenient bridges to
// builtins, native bindings, parent signalling, and addons before any workflow
// source is compiled. The parent still enforces the authenticated IPC protocol.
for (const capability of [
  "getBuiltinModule",
  "binding",
  "_linkedBinding",
  "dlopen",
  "kill",
  "abort",
  "send",
]) {
  try {
    Object.defineProperty(process, capability, {
      value: undefined,
      writable: false,
      configurable: false,
    });
  } catch {
    // The VM boundary and permission mode remain mandatory controls.
  }
}

const BOOTSTRAP = String.raw`
(function bootstrapWorkflowApi() {
  "use strict";
  const callHost = globalThis.__hostBridge;
  delete globalThis.__hostBridge;
  let nextRequestId = 0;
  const unconsumed = new Set();
  const inFlight = new Set();

  function deepFreeze(value, depth = 0) {
    if (!value || typeof value !== "object" || depth > 32 || Object.isFrozen(value)) return value;
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key], depth + 1);
    return value;
  }

  function requestAgent(promptValue, optionsValue = {}) {
    const id = ++nextRequestId;
    unconsumed.add(id);
    let started;
    const begin = () => {
      unconsumed.delete(id);
      if (started) return started;
      let payload;
      try {
        payload = JSON.stringify({
          id,
          prompt: typeof promptValue === "string" ? promptValue : String(promptValue ?? ""),
          options: optionsValue && typeof optionsValue === "object" ? optionsValue : {},
        });
      } catch (error) {
        started = Promise.reject(new Error("agent() arguments must be serializable: " + error.message));
        return started;
      }
      inFlight.add(id);
      started = callHost("agent", payload)
        .then((json) => JSON.parse(json))
        .finally(() => inFlight.delete(id));
      return started;
    };
    return Object.freeze({
      then(resolve, reject) {
        return begin().then(resolve, reject);
      },
      catch(reject) {
        return begin().catch(reject);
      },
      finally(callback) {
        return begin().finally(callback);
      },
      get [Symbol.toStringTag]() {
        return "Promise";
      },
    });
  }

  async function mapLimited(items, concurrency, invoke) {
    const results = new Array(items.length);
    let next = 0;
    const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      for (let index = next++; index < items.length; index = next++) {
        results[index] = await invoke(items[index]);
      }
    });
    await Promise.all(workers);
    return results;
  }

  async function parallel(items, options = {}) {
    if (!Array.isArray(items)) throw new Error("parallel() expects an array of zero-argument agent thunks");
    const requested = options && typeof options.concurrency === "number"
      ? Math.floor(options.concurrency)
      : 4;
    if (!Number.isFinite(requested) || requested < 1) {
      throw new Error("parallel(): concurrency must be a positive integer");
    }
    const concurrency = Math.min(4, requested);
    return mapLimited(items, concurrency, (item) => {
      if (typeof item !== "function") {
        throw new Error("parallel() items must be zero-argument functions");
      }
      return item();
    });
  }

  function phase(title) {
    callHost("phase", JSON.stringify({ title: String(title) }));
  }

  const argsEnvelope = JSON.parse(globalThis.__argsJson);
  const args = argsEnvelope.defined ? deepFreeze(argsEnvelope.value) : undefined;
  delete globalThis.__argsJson;
  const stringify = JSON.stringify;
  function serializeResult(value) {
    const seen = new WeakSet();
    return stringify(value === undefined ? null : value, (_key, item) => {
      if (typeof item === "bigint") return item.toString() + "n";
      if (item && typeof item === "object") {
        if (seen.has(item)) return "[circular]";
        seen.add(item);
      }
      return item;
    });
  }
  Object.defineProperties(globalThis, {
    agent: { value: requestAgent, writable: false, configurable: false },
    parallel: { value: parallel, writable: false, configurable: false },
    phase: { value: phase, writable: false, configurable: false },
    args: { value: args, writable: false, configurable: false },
    __workflowCheck: {
      value: Object.freeze(() => ({
        unconsumed: unconsumed.size,
        inFlight: inFlight.size,
      })),
      writable: false,
      configurable: false,
    },
    __workflowSerialize: {
      value: Object.freeze(serializeResult),
      writable: false,
      configurable: false,
    },
  });
})();
`;

let initialized = false;
let token;
const pendingAgents = new Map();

// This process runs without filesystem permissions, so it cannot load a
// validation library. A primitive string is the only value that round-trips
// through String(), which is all the IPC protocol needs to establish.
function isText(value) {
  return String(value) === value;
}

function send(message) {
  sendIpc?.({ token, ...message });
}

function fail(error) {
  const message = error instanceof Error ? error.message : String(error);
  send({ kind: "error", error: message.slice(0, 16 * 1024) });
}

process.on("message", (message) => {
  // Only the parent sends messages. Initialization is validated; later messages
  // with the wrong token or kind are ignored.
  if (!message) return;
  if (!initialized) {
    if (
      message.kind !== "init" ||
      !isText(message.token) ||
      !isText(message.source) ||
      !isText(message.argsJson)
    ) {
      process.exitCode = 1;
      return;
    }
    initialized = true;
    token = message.token;
    send({ kind: "ready" });
    run(message.source, message.argsJson);
    return;
  }
  if (message.token === token && message.kind === "ping") {
    send({ kind: "pong", seq: message.seq });
    return;
  }
  if (message.token !== token || message.kind !== "agentResult") return;
  const pending = pendingAgents.get(message.id);
  if (!pending) return;
  pendingAgents.delete(message.id);
  if (isText(message.resultJson)) pending.resolve(message.resultJson);
  else pending.reject(new Error(isText(message.error) ? message.error : "Agent IPC failed"));
});

function run(source, argsJson) {
  try {
    const sandbox = Object.create(null);
    sandbox.__argsJson = argsJson;
    sandbox.__hostBridge = (kind, payloadJson) => {
      if (kind === "phase") {
        send({ kind: "phase", payloadJson });
        return undefined;
      }
      if (kind !== "agent") return Promise.reject(new Error("Unknown workflow operation"));
      let id;
      try {
        id = JSON.parse(payloadJson).id;
      } catch {
        return Promise.reject(new Error("Invalid agent request"));
      }
      return new Promise((resolve, reject) => {
        pendingAgents.set(id, { resolve, reject });
        send({ kind: "agent", payloadJson });
      });
    };

    const context = vm.createContext(sandbox, {
      name: "pi-workflow",
      codeGeneration: { strings: false, wasm: false },
    });
    new vm.Script(BOOTSTRAP, {
      filename: "workflow-bootstrap.js",
    }).runInContext(context, { timeout: 1000 });
    const wrapped = `
      globalThis.__workflowPromise = (async function workflow(agent, parallel, phase, args) {
        "use strict";
        ${source}
      })(agent, parallel, phase, args).then(async (value) => {
        await Promise.resolve();
        const pending = __workflowCheck();
        if (pending.unconsumed > 0) {
          throw new Error("Workflow created " + pending.unconsumed + " unawaited agent() call(s)");
        }
        if (pending.inFlight > 0) {
          throw new Error("Workflow returned before " + pending.inFlight + " agent call(s) settled");
        }
        return __workflowSerialize(value);
      });
    `;
    new vm.Script(wrapped, { filename: "workflow-script.js" }).runInContext(context, {
      timeout: 1000,
    });
    Promise.resolve(context.__workflowPromise).then((resultJson) => {
      if (!isText(resultJson)) throw new Error("Workflow result was not serializable");
      send({ kind: "result", resultJson });
    }, fail);
  } catch (error) {
    fail(error);
  }
}
