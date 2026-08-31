/**
 * workflows TUI: the /workflows dashboard page, the live run cache that backs
 * it, and the prompt-footer indicator for background runs.
 *
 * The server half (`src/index.ts`) owns the runs; this half only consumes the
 * `WorkflowsRpc` contract and its progress/settled events.
 */

import { Plugin } from "@opencode-ai/plugin/tui";
import { createSignal, Show } from "solid-js";
import type { JSX } from "solid-js";
import { z } from "zod";
import { WorkflowsRpc, type RunSummary } from "./rpc.ts";
import { WorkflowsDashboard, type DashboardPort } from "./tui/dashboard.tsx";
import { createStatusStore } from "./tui/status.ts";

const PAGE_NAME = "workflows";
const PLUGIN_ID = "workflows";
const TOAST_TITLE = "Workflows";

/** Router page data is untyped transport; decode it at the boundary. */
const pageDataSchema = z.object({ runId: z.string().min(1).optional() });

export default Plugin.define({
  id: PLUGIN_ID,
  setup(context) {
    const rpc = context.client.rpc(WorkflowsRpc);
    const store = createStatusStore(context.storage);

    const current = context.location ?? context.data.location.default();
    const location = { directory: current.directory, workspace: current.workspaceID };

    type Route = ReturnType<typeof context.ui.router.current>;
    function isDashboard(route: Route): boolean {
      return route.type === "plugin" && route.id === PLUGIN_ID && route.name === PAGE_NAME;
    }

    let previousRoute: Route = { type: "home" };
    /** Session the dashboard was opened from; scopes the run list to it. */
    const [sessionFilter, setSessionFilter] = createSignal<string | undefined>(undefined);

    /** Detach the route from the host's reactive store before we keep it. */
    function snapshot(route: Route): Route {
      if (route.type === "session") return { type: "session", sessionID: route.sessionID };
      if (route.type !== "plugin") return { type: "home" };
      if (route.data === undefined) return { type: "plugin", id: route.id, name: route.name };
      return { type: "plugin", id: route.id, name: route.name, data: { ...route.data } };
    }

    function openDashboard(input?: string): void {
      const route = context.ui.router.current();
      if (!isDashboard(route)) {
        previousRoute = snapshot(route);
        setSessionFilter(route.type === "session" ? route.sessionID : undefined);
      }
      const query = input?.trim();
      if (query === undefined || query.length === 0) {
        context.ui.router.navigate({ type: "plugin", name: PAGE_NAME });
        return;
      }
      context.ui.router.navigate({ type: "plugin", name: PAGE_NAME, data: { runId: query } });
    }

    function closeDashboard(): void {
      context.ui.router.navigate(previousRoute);
    }

    const listeners = new Set<(run: RunSummary) => void>();

    const port: DashboardPort = {
      async refresh() {
        const result = await rpc.list({}, { location });
        store.replace(result.runs);
      },
      get: (runId) => rpc.get({ runId }, { location }),
      transcript: (runId, agentIndex) =>
        rpc.transcript({ runId, agentIndex }, { location }).then((result) => result.entries),
      abort: (runId) => rpc.abort({ runId }, { location }).then((result) => result.aborted),
      subscribe(handler) {
        listeners.add(handler);
        return () => {
          listeners.delete(handler);
        };
      },
      notify(message, variant) {
        context.ui.toast.show({ title: TOAST_TITLE, message, variant });
      },
    };

    // Warm start so the footer counts runs that were already going when this
    // TUI attached; a failure here only means the count waits for an event.
    void port.refresh().catch(() => undefined);

    const stopProgress = rpc.events.on("progress", (event) => {
      store.upsert(event.data.run);
      for (const listener of listeners) listener(event.data.run);
    });

    const stopSettled = rpc.events.on("settled", (event) => {
      const run = event.data.run;
      store.upsert(run);
      for (const listener of listeners) listener(run);
      if (isDashboard(context.ui.router.current())) return;
      port.notify(
        `Workflow ${run.name ?? run.runId} ${run.status}`,
        run.status === "completed" ? "success" : "warning",
      );
    });

    const removePage = context.ui.router.register({
      name: PAGE_NAME,
      render: (input) => {
        const data = pageDataSchema.safeParse(input.data ?? {});
        return (
          <WorkflowsDashboard
            context={context}
            store={store}
            port={port}
            close={closeDashboard}
            initialRunId={data.success ? data.data.runId : undefined}
            sessionID={sessionFilter()}
          />
        );
      },
    });

    // Keymap layers consume the host's Solid context, so they are registered by
    // a component mounted into the app slot, never directly in setup.
    function AppExtensions(): JSX.Element {
      context.keymap.layer(() => ({
        mode: "global",
        priority: 10,
        commands: [
          {
            id: "workflows.open",
            title: "Workflows",
            description: "Browse workflow runs",
            group: "Workflows",
            palette: true,
            bind: false,
            // No `arguments: true`: that keeps the slash command sitting in the
            // prompt for argument input; /workflows should open on enter.
            slash: { name: "workflows" },
            run: (input) => openDashboard(input),
          },
        ],
      }));
      return <></>;
    }

    const removeKeymaps = context.ui.slot({ append: "app", render: AppExtensions });

    const removeStatus = context.ui.slot({
      append: "prompt.footer.status",
      render: () => (
        <Show when={store.state.running} keyed>
          {(count: number) => (
            <text fg={context.theme.text.feedback.warning.default}>
              {`● ${count} workflow${count === 1 ? "" : "s"} running`}
            </text>
          )}
        </Show>
      ),
    });

    return () => {
      stopProgress();
      stopSettled();
      listeners.clear();
      removeStatus();
      removeKeymaps();
      removePage();
    };
  },
});
