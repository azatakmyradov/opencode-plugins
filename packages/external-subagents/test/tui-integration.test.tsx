import type { Plugin } from "@opencode-ai/plugin/tui";
import { createRoot } from "solid-js";
import { createStore, produce } from "solid-js/store";
import { describe, expect, test, vi } from "vite-plus/test";
import type {
  ExternalSubagentDetail,
  ExternalSubagentSummary,
  ExternalSubagentTranscript,
} from "../src/rpc.ts";
import tuiPlugin from "../src/tui.tsx";
import { ExternalSubagentsDashboard, type DashboardPort } from "../src/tui/dashboard.tsx";
import { createStatusStore, type StatusStore } from "../src/tui/status.ts";

// The Node export is Solid's non-reactive SSR build; the TUI uses the client runtime.
// @ts-expect-error Solid does not publish declarations for its concrete runtime files.
vi.mock("solid-js", () => import("solid-js/dist/solid.js"));
// @ts-expect-error Solid does not publish declarations for its concrete runtime files.
vi.mock("solid-js/store", () => import("solid-js/store/dist/store.js"));
vi.mock("@opentui/solid", async () => {
  // @ts-expect-error Solid does not publish declarations for its concrete runtime files.
  const solid = await import("solid-js/dist/solid.js");
  return {
    createComponent: solid.createComponent,
    createElement: (type: string) => ({ headless: true, type, props: {} }),
    spread: (node: HeadlessNode, props: object) => {
      Object.defineProperties(node.props, Object.getOwnPropertyDescriptors(props));
      return node;
    },
  };
});
vi.mock("@opentui/solid/jsx-runtime", async () => {
  // @ts-expect-error Solid does not publish declarations for its concrete runtime files.
  const solid = await import("solid-js/dist/solid.js");
  const jsx = (type: string | ((props: object) => unknown), props: object = {}) => {
    if (typeof type === "function") return solid.createComponent(type, props);
    return { headless: true, type, props };
  };
  return { Fragment: (props: { children?: unknown }) => props.children, jsx, jsxs: jsx };
});
vi.mock("@opentui/solid/jsx-dev-runtime", async () => {
  // @ts-expect-error Solid does not publish declarations for its concrete runtime files.
  const solid = await import("solid-js/dist/solid.js");
  const jsxDEV = (type: string | ((props: object) => unknown), props: object = {}) => {
    if (typeof type === "function") return solid.createComponent(type, props);
    return { headless: true, type, props };
  };
  return { Fragment: (props: { children?: unknown }) => props.children, jsxDEV };
});

interface HeadlessNode {
  readonly headless: true;
  readonly type: string;
  readonly props: Record<string, unknown>;
}

interface HeadlessSetup {
  destroy(): void;
  flush(): Promise<void>;
  waitFor(predicate: () => boolean | Promise<boolean>): Promise<void>;
}

async function headlessRender(factory: () => unknown): Promise<HeadlessSetup> {
  let dispose: () => void = () => undefined;
  createRoot((cleanup) => {
    dispose = cleanup;
    factory();
  });

  const flush = async () => {
    await Promise.resolve();
    await Promise.resolve();
  };
  const waitFor = async (predicate: () => boolean | Promise<boolean>) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      await flush();
      if (await predicate()) return;
    }
    throw new Error("Headless component did not reach the expected state");
  };
  return { destroy: dispose, flush, waitFor };
}

interface Deferred<Value> {
  readonly promise: Promise<Value>;
  resolve(value: Value): void;
  reject(cause: unknown): void;
}

function deferred<Value>(): Deferred<Value> {
  let resolve!: (value: Value) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<Value>((accept, deny) => {
    resolve = accept;
    reject = deny;
  });
  return { promise, resolve, reject };
}

function summary(
  id: string,
  createdAt: number,
  sessionID = "ses_parent",
  status: ExternalSubagentSummary["status"] = "running",
): ExternalSubagentSummary {
  return {
    id,
    sessionID,
    backend: "codex",
    title: id,
    status,
    createdAt,
    compacting: false,
    compactionCount: 0,
    cancelled: false,
    turns: 0,
    queuedCount: 0,
    liveToolCount: 0,
    preview: "",
  };
}

function detail(
  run: ExternalSubagentSummary,
  input: Partial<ExternalSubagentDetail> = {},
): ExternalSubagentDetail {
  return {
    ...run,
    sessionTitle: run.title,
    prompt: `prompt for ${run.id}`,
    cwd: "/workspace",
    queued: [],
    liveTools: [],
    finalText: "",
    ...input,
  };
}

const EMPTY_TRANSCRIPT: ExternalSubagentTranscript = { entries: [], liveTools: [] };

interface ReactiveStorageHarness {
  readonly states: Map<string, object>;
  readonly storage: Plugin.Context["storage"];
}

function reactiveStorage(): ReactiveStorageHarness {
  const states = new Map<string, object>();
  const storage = {
    memory: <State extends object>(key: string, options: { initial: State }) => {
      const [state, setState] = createStore(structuredClone(options.initial));
      states.set(key, state);
      return [state, (mutation: (draft: State) => void) => setState(produce(mutation))] as const;
    },
  } as unknown as Plugin.Context["storage"];
  return { states, storage };
}

type TestCommand = { readonly id?: string; readonly run: () => void | Promise<void> };
type TestLayer = { readonly commands?: readonly TestCommand[] };

interface DashboardContextHarness {
  readonly context: Plugin.Context;
  readonly activeModes: () => number;
  run(id: string): void;
}

function dashboardContext(): DashboardContextHarness {
  let layer: (() => TestLayer) | undefined;
  let activeModes = 0;
  const context = {
    location: { directory: "/workspace", workspaceID: "workspace" },
    renderer: { terminalWidth: 140, terminalHeight: 70 },
    theme: {
      text: {
        default: "#ffffff",
        subdued: "#888888",
        action: { primary: { default: "#00ffff" } },
        feedback: {
          error: { default: "#ff0000" },
          info: { default: "#0000ff" },
          success: { default: "#00ff00" },
          warning: { default: "#ffff00" },
        },
      },
    },
    keymap: {
      layer(input: () => TestLayer) {
        layer = input;
      },
      mode: {
        push: () => {
          activeModes++;
          return () => activeModes--;
        },
      },
    },
    ui: { format: { path: (value: string) => value } },
  } as unknown as Plugin.Context;

  return {
    context,
    activeModes: () => activeModes,
    run(id: string): void {
      const command = layer?.().commands?.find((candidate) => candidate.id === id);
      if (command === undefined) throw new Error(`Missing command: ${id}`);
      void command.run();
    },
  };
}

interface PortHarnessOptions {
  readonly refresh?: () => Promise<void>;
  readonly get?: (handle: string, sessionID: string) => Promise<ExternalSubagentDetail>;
  readonly transcript?: (handle: string, sessionID: string) => Promise<ExternalSubagentTranscript>;
  readonly notify?: (message: string, variant: "info" | "success" | "warning" | "error") => void;
}

interface PortHarness {
  readonly port: DashboardPort;
  emit(handle?: string): void;
}

function portHarness(input: PortHarnessOptions = {}): PortHarness {
  const listeners = new Set<(handle?: string) => void>();
  const port: DashboardPort = {
    refresh: input.refresh ?? (() => Promise.resolve()),
    get:
      input.get ??
      ((handle) => Promise.reject(new Error(`Unexpected detail request for ${handle}`))),
    transcript: input.transcript ?? (() => Promise.resolve(EMPTY_TRANSCRIPT)),
    subscribe(handler) {
      listeners.add(handler);
      return () => listeners.delete(handler);
    },
    notify: input.notify ?? (() => undefined),
  };
  return {
    port,
    emit(handle?: string) {
      for (const listener of listeners) listener(handle);
    },
  };
}

interface MountedDashboard extends DashboardContextHarness {
  readonly setup: HeadlessSetup;
  readonly store: StatusStore;
}

async function mountDashboard(input: {
  runs: ExternalSubagentSummary[];
  port: DashboardPort;
  initialHandle?: string;
  selectedHandle?: string;
}): Promise<MountedDashboard> {
  const { storage } = reactiveStorage();
  const store = createStatusStore(storage);
  store.replace(input.runs);
  if (input.selectedHandle !== undefined) store.select(input.selectedHandle);
  const keys = dashboardContext();
  const setup = await headlessRender(() => (
    <ExternalSubagentsDashboard
      context={keys.context}
      store={store}
      port={input.port}
      close={() => undefined}
      initialHandle={input.initialHandle}
      sessionID="ses_parent"
    />
  ));
  await setup.flush();
  return { ...keys, setup, store };
}

describe("external subagent dashboard integration", () => {
  test("reloads detail and transcript for changes omitted from summaries", async () => {
    const run = summary("codex:one", 1);
    let currentDetail = detail(run, {
      queued: [{ kind: "steer", text: "queue old" }],
      liveAssistant: { text: "", thinking: "thinking old" },
      liveTools: [{ toolId: "tool", name: "shell", outputPreview: "tool old" }],
    });
    let currentTranscript: ExternalSubagentTranscript = {
      entries: [{ kind: "user", text: "transcript old" }],
      liveTools: [],
    };
    let detailRequests = 0;
    let transcriptRequests = 0;
    const port = portHarness({
      get: () => {
        detailRequests++;
        return Promise.resolve(structuredClone(currentDetail));
      },
      transcript: () => {
        transcriptRequests++;
        return Promise.resolve(structuredClone(currentTranscript));
      },
    });
    const dashboard = await mountDashboard({ runs: [run], port: port.port });
    try {
      dashboard.run("external-subagents.open-selection");
      await dashboard.setup.waitFor(() => detailRequests === 1);

      currentDetail = detail(run, {
        queued: [{ kind: "steer", text: "queue old" }],
        liveAssistant: { text: "", thinking: "thinking new" },
        liveTools: [{ toolId: "tool", name: "shell", outputPreview: "tool old" }],
      });
      port.emit(run.id);
      await dashboard.setup.waitFor(() => detailRequests === 2);

      currentDetail = detail(run, {
        queued: [{ kind: "steer", text: "queue new" }],
        liveAssistant: { text: "", thinking: "thinking new" },
        liveTools: [{ toolId: "tool", name: "shell", outputPreview: "tool old" }],
      });
      port.emit(run.id);
      await dashboard.setup.waitFor(() => detailRequests === 3);

      currentDetail = detail(run, {
        queued: [{ kind: "steer", text: "queue new" }],
        liveAssistant: { text: "", thinking: "thinking new" },
        liveTools: [{ toolId: "tool", name: "shell", outputPreview: "tool new" }],
      });
      port.emit(run.id);
      await dashboard.setup.waitFor(() => detailRequests === 4);

      dashboard.run("external-subagents.open-selection");
      await dashboard.setup.waitFor(() => transcriptRequests === 1);
      currentTranscript = {
        entries: [{ kind: "user", text: "transcript new" }],
        liveTools: [],
      };
      port.emit(run.id);
      await dashboard.setup.waitFor(() => transcriptRequests === 2);
    } finally {
      dashboard.setup.destroy();
    }
  });

  test("discards stale detail responses across A-to-B navigation", async () => {
    const runA = summary("codex:A", 2);
    const runB = summary("codex:B", 1);
    const requestA = deferred<ExternalSubagentDetail>();
    const requestB = deferred<ExternalSubagentDetail>();
    const requested: string[] = [];
    const transcriptRequests: string[] = [];
    const port = portHarness({
      get: (handle) => {
        requested.push(handle);
        return handle === runA.id ? requestA.promise : requestB.promise;
      },
      transcript: (handle) => {
        transcriptRequests.push(handle);
        return Promise.resolve(EMPTY_TRANSCRIPT);
      },
    });
    const dashboard = await mountDashboard({ runs: [runA, runB], port: port.port });
    try {
      dashboard.run("external-subagents.open-selection");
      dashboard.run("external-subagents.back");
      dashboard.run("external-subagents.next");
      dashboard.run("external-subagents.open-selection");
      expect(requested).toEqual([runA.id]);

      requestA.resolve(detail(runA, { finalText: "STALE_A_DETAIL" }));
      await dashboard.setup.waitFor(() => requested.includes(runB.id));
      dashboard.run("external-subagents.open-selection");
      await dashboard.setup.flush();
      expect(transcriptRequests).toEqual([]);

      requestB.resolve(detail(runB, { finalText: "FRESH_B_DETAIL" }));
      await dashboard.setup.flush();
      dashboard.run("external-subagents.open-selection");
      await dashboard.setup.waitFor(() => transcriptRequests.length === 1);
      expect(transcriptRequests).toEqual([runB.id]);
    } finally {
      dashboard.setup.destroy();
    }
  });

  test("discards stale transcript responses across handle changes", async () => {
    const runA = summary("codex:A", 2);
    const runB = summary("codex:B", 1);
    const transcriptA = deferred<ExternalSubagentTranscript>();
    const transcriptB = deferred<ExternalSubagentTranscript>();
    const requested: string[] = [];
    const detailRequests: string[] = [];
    const port = portHarness({
      get: (handle) => {
        detailRequests.push(handle);
        return Promise.resolve(detail(handle === runA.id ? runA : runB));
      },
      transcript: (handle) => {
        requested.push(handle);
        return handle === runA.id ? transcriptA.promise : transcriptB.promise;
      },
    });
    const dashboard = await mountDashboard({ runs: [runA, runB], port: port.port });
    try {
      dashboard.run("external-subagents.open-selection");
      await dashboard.setup.waitFor(() => detailRequests.includes(runA.id));
      dashboard.run("external-subagents.open-selection");
      await dashboard.setup.waitFor(() => requested.includes(runA.id));
      dashboard.run("external-subagents.back");
      dashboard.run("external-subagents.back");
      dashboard.run("external-subagents.next");
      dashboard.run("external-subagents.open-selection");
      await dashboard.setup.waitFor(() => detailRequests.includes(runB.id));
      dashboard.run("external-subagents.open-selection");
      expect(requested).toEqual([runA.id]);

      transcriptA.resolve({
        entries: [{ kind: "user", text: "STALE_A_TRANSCRIPT" }],
        liveTools: [],
      });
      await dashboard.setup.waitFor(() => requested.includes(runB.id));

      transcriptB.resolve({
        entries: [{ kind: "user", text: "FRESH_B_TRANSCRIPT" }],
        liveTools: [],
      });
      await dashboard.setup.flush();
      expect(requested).toEqual([runA.id, runB.id]);
    } finally {
      dashboard.setup.destroy();
    }
  });

  test("keeps selection by handle, backs out pruned detail, and cancels a pending g chord", async () => {
    const runA = summary("codex:A", 2);
    const runB = summary("codex:B", 1);
    const requested: string[] = [];
    const transcripts: string[] = [];
    const port = portHarness({
      get: (handle) => {
        requested.push(handle);
        return Promise.resolve(detail(handle === runA.id ? runA : runB));
      },
      transcript: (handle) => {
        transcripts.push(handle);
        return Promise.resolve(EMPTY_TRANSCRIPT);
      },
    });
    const dashboard = await mountDashboard({ runs: [runA, runB], port: port.port });
    try {
      dashboard.run("external-subagents.next");
      dashboard.store.replace([summary(runB.id, 3), runA]);
      port.emit();
      await dashboard.setup.flush();
      dashboard.run("external-subagents.open-selection");
      await dashboard.setup.waitFor(() => requested.length === 1);
      expect(requested.at(-1)).toBe(runB.id);
      dashboard.run("external-subagents.back");

      dashboard.run("external-subagents.top-vim");
      dashboard.run("external-subagents.next");
      dashboard.run("external-subagents.top-vim");
      dashboard.run("external-subagents.open-selection");
      await dashboard.setup.waitFor(() => requested.length === 2);
      expect(requested.at(-1)).toBe(runA.id);
      await dashboard.setup.flush();
      dashboard.store.replace([summary(runB.id, 3)]);
      port.emit(runA.id);
      await dashboard.setup.flush();
      dashboard.run("external-subagents.open-selection");
      await dashboard.setup.flush();
      expect(transcripts).toEqual([]);
      await dashboard.setup.waitFor(() => requested.length === 3);
      expect(requested.at(-1)).toBe(runB.id);
    } finally {
      dashboard.setup.destroy();
    }
  });

  test("continues a detail reload after a failed list refresh", async () => {
    const run = summary("codex:one", 1);
    let refreshes = 0;
    let details = 0;
    const port = portHarness({
      refresh: () => {
        refreshes++;
        return refreshes === 1 ? Promise.resolve() : Promise.reject(new Error("list stale"));
      },
      get: () => {
        details++;
        return Promise.resolve(detail(run));
      },
    });
    const dashboard = await mountDashboard({ runs: [run], port: port.port });
    try {
      await dashboard.setup.waitFor(() => refreshes === 1);
      dashboard.run("external-subagents.open-selection");
      await dashboard.setup.waitFor(() => details === 1);
      dashboard.run("external-subagents.refresh");
      await dashboard.setup.waitFor(() => refreshes === 2 && details === 2);
    } finally {
      dashboard.setup.destroy();
    }
  });

  test("does not notify from a delayed initial lookup after unmount", async () => {
    const run = summary("codex:one", 1);
    const refresh = deferred<void>();
    const notifications: string[] = [];
    const port = portHarness({
      refresh: () => refresh.promise,
      notify: (message) => notifications.push(message),
    });
    const dashboard = await mountDashboard({
      runs: [run],
      port: port.port,
      initialHandle: "missing",
    });
    expect(dashboard.activeModes()).toBe(1);
    dashboard.setup.destroy();
    expect(dashboard.activeModes()).toBe(0);
    refresh.resolve(undefined);
    await Promise.resolve();
    await Promise.resolve();
    expect(notifications).toEqual([]);
  });

  test("does not overwrite keyboard selection after a delayed initial refresh", async () => {
    const runA = summary("codex:A", 2);
    const runB = summary("codex:B", 1);
    const refresh = deferred<void>();
    const requested: string[] = [];
    const port = portHarness({
      refresh: () => refresh.promise,
      get: (handle) => {
        requested.push(handle);
        return Promise.resolve(detail(handle === runA.id ? runA : runB));
      },
    });
    const dashboard = await mountDashboard({
      runs: [runA, runB],
      port: port.port,
      selectedHandle: runA.id,
    });
    try {
      dashboard.run("external-subagents.next");
      refresh.resolve(undefined);
      await dashboard.setup.flush();
      dashboard.run("external-subagents.open-selection");
      await dashboard.setup.waitFor(() => requested.length === 1);

      expect(requested).toEqual([runB.id]);
    } finally {
      dashboard.setup.destroy();
    }
  });
});

interface PluginHarness {
  context: Plugin.Context;
  readonly events: {
    emit(name: "changed" | "settled", data: unknown): void;
  };
  readonly pages: Array<{
    name: string;
    render: (input: { data?: Record<string, unknown> }) => unknown;
  }>;
  readonly slots: Array<{
    append?: string;
    render: (input: Record<string, never>) => unknown;
  }>;
  readonly toasts: Array<{ message: string; variant?: string }>;
  readonly storageStates: Map<string, object>;
  run(id: string): void;
  route:
    | { type: "home" }
    | { type: "session"; sessionID: string }
    | {
        type: "plugin";
        id: string;
        name: string;
        data?: Record<string, unknown>;
      };
}

function pluginHarness(
  list: () => Promise<ExternalSubagentSummary[]>,
  get: (handle: string) => Promise<ExternalSubagentDetail> = (handle) =>
    Promise.reject(new Error(`Unexpected detail request for ${handle}`)),
): PluginHarness {
  const storage = reactiveStorage();
  const dashboard = dashboardContext();
  const handlers = new Map<string, Set<(event: { data: unknown }) => void>>();
  const pages: PluginHarness["pages"] = [];
  const slots: PluginHarness["slots"] = [];
  const toasts: PluginHarness["toasts"] = [];
  const harness: PluginHarness = {
    route: { type: "session", sessionID: "ses_parent" },
    pages,
    slots,
    toasts,
    storageStates: storage.states,
    events: {
      emit(name, data) {
        for (const handler of handlers.get(name) ?? []) handler({ data });
      },
    },
    context: undefined as unknown as Plugin.Context,
    run: (id) => dashboard.run(id),
  };
  const rpc = {
    list,
    get: ({ id }: { id: string }) => get(id),
    transcript: () => Promise.resolve(EMPTY_TRANSCRIPT),
    events: {
      on(name: string, handler: (event: { data: unknown }) => void) {
        const listeners = handlers.get(name) ?? new Set();
        listeners.add(handler);
        handlers.set(name, listeners);
        return () => listeners.delete(handler);
      },
    },
  };
  harness.context = {
    ...dashboard.context,
    storage: storage.storage,
    client: { rpc: () => rpc },
    data: {
      location: {
        default: () => ({ directory: "/workspace", workspaceID: "workspace" }),
      },
    },
    ui: {
      ...dashboard.context.ui,
      toast: { show: (toast: { message: string; variant?: string }) => toasts.push(toast) },
      router: {
        current: () => harness.route,
        navigate: (
          destination:
            | PluginHarness["route"]
            | { type: "plugin"; name: string; data?: Record<string, unknown> },
        ) => {
          harness.route =
            destination.type === "plugin" && !("id" in destination)
              ? { ...destination, id: "external-subagents" }
              : destination;
        },
        register: (page: PluginHarness["pages"][number]) => {
          pages.push(page);
          return () => undefined;
        },
      },
      slot: (claim: PluginHarness["slots"][number]) => {
        slots.push(claim);
        return () => undefined;
      },
    },
  } as unknown as Plugin.Context;
  return harness;
}

describe("external subagent TUI event integration", () => {
  test("restores the originating route when the dashboard closes", async () => {
    const harness = pluginHarness(() => Promise.resolve([]));
    const cleanup = await tuiPlugin.setup(harness.context);
    const appSlot = harness.slots.find((slot) => slot.append === "app");
    const page = harness.pages[0];
    if (appSlot === undefined || page === undefined)
      throw new Error("TUI registrations are missing");
    const app = await headlessRender(() => appSlot.render({}));
    let dashboard: HeadlessSetup | undefined;
    try {
      harness.run("external-subagents.open");
      expect(harness.route).toEqual({
        type: "plugin",
        id: "external-subagents",
        name: "subagents",
        data: { sessionID: "ses_parent" },
      });
      dashboard = await headlessRender(() =>
        page.render({ data: harness.route.type === "plugin" ? harness.route.data : undefined }),
      );
      harness.run("external-subagents.close");
      expect(harness.route).toEqual({ type: "session", sessionID: "ses_parent" });
    } finally {
      dashboard?.destroy();
      app.destroy();
      await cleanup?.();
    }
  });

  test("preserves handle invalidations added while a cache refresh is in flight", async () => {
    const runA = summary("codex:A", 2);
    const runB = summary("codex:B", 1);
    const blocked = deferred<ExternalSubagentSummary[]>();
    let blockLists = false;
    let currentB = detail(runB, {
      liveAssistant: { text: "", thinking: "thinking old" },
    });
    let detailRequests = 0;
    const harness = pluginHarness(
      () => (blockLists ? blocked.promise : Promise.resolve([runA, runB])),
      (handle) => {
        detailRequests++;
        return Promise.resolve(structuredClone(handle === runA.id ? detail(runA) : currentB));
      },
    );
    const cleanup = await tuiPlugin.setup(harness.context);
    await Promise.resolve();
    const page = harness.pages[0];
    if (page === undefined) throw new Error("Dashboard page was not registered");
    harness.route = {
      type: "plugin",
      id: "external-subagents",
      name: "subagents",
      data: { sessionID: "ses_parent", handle: runB.id },
    };
    const setup = await headlessRender(
      () =>
        page.render({
          data: { sessionID: "ses_parent", handle: runB.id },
        }) as never,
    );
    try {
      await setup.waitFor(() => detailRequests === 1);
      blockLists = true;
      harness.events.emit("changed", { handles: [runA.id] });
      currentB = detail(runB, {
        liveAssistant: { text: "", thinking: "thinking new" },
      });
      harness.events.emit("changed", { handles: [runB.id] });
      blocked.resolve([runA, runB]);
      await setup.waitFor(() => detailRequests === 2);
    } finally {
      setup.destroy();
      await cleanup?.();
    }
  });

  test("toasts fast terminal events unless viewing the matching parent session", async () => {
    const harness = pluginHarness(() => Promise.resolve([]));
    const cleanup = await tuiPlugin.setup(harness.context);
    try {
      harness.route = {
        type: "plugin",
        id: "external-subagents",
        name: "subagents",
        data: { sessionID: "ses_A" },
      };
      harness.events.emit("settled", { run: summary("codex:A", 1, "ses_A", "done") });
      harness.events.emit("settled", { run: summary("codex:B", 1, "ses_B", "error") });
      harness.route = { type: "home" };
      harness.events.emit("settled", { run: summary("codex:fast", 1, "ses_A", "done") });

      expect(harness.toasts.map((toast) => toast.message)).toEqual([
        "codex:B failed",
        "codex:fast done",
      ]);
    } finally {
      await cleanup?.();
    }
  });

  test("reconciles a settled event against the source list after pruning", async () => {
    const run = summary("codex:pruned", 1, "ses_parent", "done");
    let listed = [run];
    let listRequests = 0;
    const harness = pluginHarness(() => {
      listRequests++;
      return Promise.resolve(listed);
    });
    const cleanup = await tuiPlugin.setup(harness.context);
    const state = harness.storageStates.get("runs") as
      | { runs?: ExternalSubagentSummary[] }
      | undefined;
    try {
      for (let attempt = 0; attempt < 100 && state?.runs?.length !== 1; attempt++) {
        await Promise.resolve();
      }
      listed = [];
      harness.events.emit("settled", { run });
      for (
        let attempt = 0;
        attempt < 100 && (listRequests < 2 || state?.runs?.length !== 0);
        attempt++
      ) {
        await Promise.resolve();
      }

      expect(listRequests).toBeGreaterThanOrEqual(2);
      expect(state?.runs).toEqual([]);
    } finally {
      await cleanup?.();
    }
  });

  test("does not publish an in-flight warm response after plugin teardown", async () => {
    const blocked = deferred<ExternalSubagentSummary[]>();
    const harness = pluginHarness(() => blocked.promise);
    const cleanup = await tuiPlugin.setup(harness.context);
    await cleanup?.();
    blocked.resolve([summary("codex:late", 1)]);
    await Promise.resolve();
    await Promise.resolve();

    const state = harness.storageStates.get("runs") as { loaded?: boolean } | undefined;
    expect(state?.loaded).toBe(false);
    expect(harness.toasts).toEqual([]);
  });
});
