import { Plugin } from "@opencode-ai/plugin/tui";
import { createSignal, For, Show } from "solid-js";
import type { JSX } from "solid-js";
import { z } from "zod";
import { ExternalSubagentsRpc, type ExternalSubagentSummary } from "./rpc.ts";
import { ExternalSubagentsDashboard, type DashboardPort } from "./tui/dashboard.tsx";
import * as Format from "./tui/format.ts";
import { createStatusStore } from "./tui/status.ts";

const PAGE_NAME = "subagents";
const PLUGIN_ID = "external-subagents";
const TOAST_TITLE = "External subagents";

/** Router page data is untyped transport; decode it at the boundary. */
const pageDataSchema = z.object({
  sessionID: z.string().min(1).optional(),
  handle: z.string().min(1).optional(),
});

export default Plugin.define({
  id: PLUGIN_ID,
  setup(context) {
    const rpc = context.client.rpc(ExternalSubagentsRpc);
    const store = createStatusStore(context.storage);
    const currentLocation = context.location ?? context.data.location.default();
    const location = {
      directory: currentLocation.directory,
      workspace: currentLocation.workspaceID,
    };

    type Route = ReturnType<typeof context.ui.router.current>;

    function isDashboard(route: Route): boolean {
      return route.type === "plugin" && route.id === PLUGIN_ID && route.name === PAGE_NAME;
    }

    /** Detach retained route data from the host's reactive object. */
    function snapshot(route: Route): Route {
      if (route.type === "session") return { type: "session", sessionID: route.sessionID };
      if (route.type !== "plugin") return { type: "home" };
      if (route.data === undefined) return { type: "plugin", id: route.id, name: route.name };
      return { type: "plugin", id: route.id, name: route.name, data: { ...route.data } };
    }

    function routeSessionID(route: Route): string | undefined {
      if (route.type === "session") return route.sessionID;
      if (route.type !== "plugin" || !isDashboard(route)) return undefined;
      const data = pageDataSchema.safeParse(route.data ?? {});
      return data.success ? data.data.sessionID : undefined;
    }

    const initialRoute = snapshot(context.ui.router.current());
    const initialSessionID = routeSessionID(initialRoute);
    let previousRoute = initialRoute;
    if (isDashboard(initialRoute)) {
      if (initialSessionID === undefined) {
        previousRoute = { type: "home" };
      } else {
        previousRoute = { type: "session", sessionID: initialSessionID };
      }
    }
    const [sessionFilter, setSessionFilter] = createSignal<string | undefined>(initialSessionID);

    function openDashboard(): void {
      const route = context.ui.router.current();
      if (!isDashboard(route)) {
        previousRoute = snapshot(route);
        setSessionFilter(route.type === "session" ? route.sessionID : undefined);
      }
      const sessionID = route.type === "session" ? route.sessionID : sessionFilter();
      if (sessionID === undefined) {
        context.ui.router.navigate({ type: "plugin", name: PAGE_NAME });
      } else {
        context.ui.router.navigate({
          type: "plugin",
          name: PAGE_NAME,
          data: { sessionID },
        });
      }
    }

    function closeDashboard(): void {
      context.ui.router.navigate(previousRoute);
    }

    const listeners = new Set<(handle?: string) => void>();
    const pendingHandles = new Set<string>();
    let refreshPending = false;
    let refreshShouldNotify = false;
    let refreshInFlight: Promise<void> | undefined;
    let disposed = false;

    function publishInvalidations(): void {
      if (!refreshShouldNotify) return;
      const handles = [...pendingHandles];
      refreshShouldNotify = false;
      pendingHandles.clear();
      if (handles.length === 0) {
        for (const listener of listeners) listener();
        return;
      }
      for (const handle of handles) {
        for (const listener of listeners) listener(handle);
      }
    }

    function settlementToast(run: ExternalSubagentSummary): void {
      const route = context.ui.router.current();
      const dashboardSessionID = isDashboard(route)
        ? (routeSessionID(route) ?? sessionFilter())
        : undefined;
      if (dashboardSessionID === run.sessionID) return;
      const status = Format.displayStatus(run.status, run.cancelled);
      let variant: "success" | "warning" | "error";
      if (status === "done") {
        variant = "success";
      } else if (status === "aborted") {
        variant = "warning";
      } else {
        variant = "error";
      }
      context.ui.toast.show({
        title: TOAST_TITLE,
        message: `${run.title} ${status}`,
        variant,
      });
    }

    /**
     * Serialize and coalesce full-cache refreshes. Full replacement is
     * intentional: manager pruning must remove stale process-local handles.
     */
    function refreshStore(handles?: readonly string[]): Promise<void> {
      if (disposed) return Promise.resolve();
      refreshPending = true;
      if (handles !== undefined) {
        refreshShouldNotify = true;
        for (const handle of handles) pendingHandles.add(handle);
      }
      if (refreshInFlight !== undefined) return refreshInFlight;

      refreshInFlight = (async () => {
        while (refreshPending && !disposed) {
          refreshPending = false;
          let next: ExternalSubagentSummary[];
          try {
            next = await rpc.list({}, { location });
          } catch (cause) {
            if (!disposed) publishInvalidations();
            throw cause;
          }
          if (disposed) return;
          store.replace(next);
          publishInvalidations();
        }
      })().finally(() => {
        refreshInFlight = undefined;
        if (refreshPending && !disposed) void refreshStore().catch(() => undefined);
      });
      return refreshInFlight;
    }

    const port: DashboardPort = {
      refresh() {
        return refreshStore();
      },
      get(handle, sessionID) {
        return rpc.get({ id: handle, sessionID }, { location });
      },
      transcript(handle, sessionID) {
        return rpc.transcript({ id: handle, sessionID }, { location });
      },
      subscribe(handler) {
        listeners.add(handler);
        return () => listeners.delete(handler);
      },
      notify(message, variant) {
        context.ui.toast.show({ title: TOAST_TITLE, message, variant });
      },
    };

    // Warm the location-wide cache so footer counts include work that predates
    // this TUI. A warm failure is intentionally silent; explicit refreshes are not.
    void refreshStore().catch(() => undefined);

    const stopChanged = rpc.events.on("changed", (event) => {
      if (disposed) return;
      void refreshStore(event.data.handles).catch(() => undefined);
    });

    const stopSettled = rpc.events.on("settled", (event) => {
      if (disposed) return;
      const run = event.data.run;
      store.upsert(run);
      for (const listener of listeners) listener(run.id);
      settlementToast(run);
      // A run can be pruned immediately after settlement. Reconcile from the
      // source so an out-of-order event cannot resurrect a removed handle.
      void refreshStore().catch(() => undefined);
    });

    const removePage = context.ui.router.register({
      name: PAGE_NAME,
      render: (input) => {
        const data = pageDataSchema.safeParse(input.data ?? {});
        const decoded = data.success ? data.data : {};
        return (
          <ExternalSubagentsDashboard
            context={context}
            store={store}
            port={port}
            close={closeDashboard}
            initialHandle={decoded.handle}
            sessionID={decoded.sessionID ?? sessionFilter()}
          />
        );
      },
    });

    // Keymap layers require the host Solid owner, so the global command is
    // registered from an app-slot component rather than directly in setup.
    function AppExtensions(): JSX.Element {
      context.keymap.layer(() => ({
        mode: "global",
        priority: 10,
        commands: [
          {
            id: "external-subagents.open",
            title: "External subagents",
            description: "Browse Claude Code and Codex sessions",
            group: "External subagents",
            palette: true,
            bind: false,
            slash: { name: PAGE_NAME },
            run: openDashboard,
          },
        ],
      }));
      return <></>;
    }

    const removeKeymaps = context.ui.slot({ append: "app", render: AppExtensions });
    const footerSegments = () =>
      [
        {
          count: store.state.running,
          text: "running",
          glyph: "●",
          color: context.theme.text.feedback.warning.default,
        },
        {
          count: store.state.queued,
          text: "queued",
          glyph: "□",
          color: context.theme.text.subdued,
        },
      ].filter((segment) => segment.count > 0);

    const removeStatus = context.ui.slot({
      append: "prompt.footer.status",
      render: () => (
        <Show when={footerSegments().length > 0}>
          <box flexDirection="row" gap={1}>
            <text fg={context.theme.text.subdued}>subagents:</text>
            <For each={footerSegments()}>
              {(segment, index) => (
                <>
                  <Show when={index() > 0}>
                    <text fg={context.theme.text.subdued}>·</text>
                  </Show>
                  <text fg={segment.color}>
                    {`${segment.glyph} ${segment.count} ${segment.text}`}
                  </text>
                </>
              )}
            </For>
          </box>
        </Show>
      ),
    });

    return () => {
      disposed = true;
      refreshPending = false;
      refreshShouldNotify = false;
      pendingHandles.clear();
      stopChanged();
      stopSettled();
      listeners.clear();
      removeStatus();
      removeKeymaps();
      removePage();
    };
  },
});
