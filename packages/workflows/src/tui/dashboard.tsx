/**
 * The /workflows dashboard: a plugin router page with three views.
 *
 *   list → detail → transcript
 *
 * The page owns navigation and its own keymap layer (pushed as a dedicated
 * input mode while mounted, so plain letter keys are unambiguous). Run data
 * comes from the injected {@link DashboardPort}; the run list itself lives in
 * the plugin's memory store so it survives closing the page.
 */

import type { Plugin } from "@opencode-ai/plugin/tui";
import { TextAttributes } from "@opentui/core";
import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import type { JSX } from "solid-js";
import { errorText as failureText } from "../core/error.ts";
import type { AgentSummary, RunDetail, RunSummary, TranscriptItem } from "../rpc.ts";
import * as Format from "./format.ts";
import type { StatusStore } from "./status.ts";

/** Input mode pushed while the dashboard is mounted. */
export const DASHBOARD_MODE = "workflows";

/** Lines of the run result the detail view previews under its agents. */
const RESULT_PREVIEW_LINES = 6;

/** Two `g` presses within this window make the gg top-jump chord. */
const TOP_CHORD_WINDOW_MS = 600;

type View = "list" | "detail" | "transcript";

/** Which of the detail view's two panes takes j/k and enter. */
type DetailFocus = "phases" | "agents";

type Notice = "info" | "success" | "warning" | "error";

/** Everything the dashboard needs from the plugin, already bound to a location. */
export interface DashboardPort {
  /** Fetch `list` and publish it into the memory store. */
  refresh(): Promise<void>;
  get(runId: string): Promise<RunDetail>;
  transcript(runId: string, agentIndex: number): Promise<readonly TranscriptItem[]>;
  abort(runId: string): Promise<boolean>;
  /** Progress and settled events for every run, after the store was patched. */
  subscribe(handler: (run: RunSummary) => void): () => void;
  notify(message: string, variant: Notice): void;
}

interface DashboardProps {
  readonly context: Plugin.Context;
  readonly store: StatusStore;
  readonly port: DashboardPort;
  readonly close: () => void;
  readonly initialRunId?: string;
  /** When set, only runs launched from this session are listed. */
  readonly sessionID?: string;
}

interface ListRow {
  readonly run: RunSummary;
  readonly index: number;
}

interface PhaseRow {
  readonly group: Format.PhaseGroup;
  readonly index: number;
}

/**
 * A row of the agents pane. Agent rows carry their index in the selected phase;
 * notes are the continuation lines underneath (errors, the empty-phase hint and
 * the run's own failure).
 */
type AgentRow =
  | { readonly kind: "agent"; readonly agent: AgentSummary; readonly index: number }
  | {
      readonly kind: "note";
      readonly text: string;
      readonly tone: Format.Tone;
      readonly arrow: boolean;
    }
  | { readonly kind: "blank" };

export function WorkflowsDashboard(props: DashboardProps): JSX.Element {
  const theme = props.context.theme;
  const accent = theme.text.action.primary.default;

  const [view, setView] = createSignal<View>("list");
  const [listIndex, setListIndex] = createSignal(0);
  const [detail, setDetail] = createSignal<RunDetail | undefined>(undefined);
  const [detailFocus, setDetailFocus] = createSignal<DetailFocus>("phases");
  const [phaseIndex, setPhaseIndex] = createSignal(0);
  const [agentIndex, setAgentIndex] = createSignal(0);
  const [entries, setEntries] = createSignal<readonly TranscriptItem[]>([]);
  const [scroll, setScroll] = createSignal(0);
  const [failure, setFailure] = createSignal<string | undefined>(undefined);
  // Doubles as the render tick: live elapsed times and terminal size follow it.
  const [now, setNow] = createSignal(Date.now());
  let lastTopChordAt = 0;

  function tone(name: Format.Tone) {
    if (name === "default") return theme.text.default;
    if (name === "subdued") return theme.text.subdued;
    // Amber, not the host running color: many themes render status.running too
    // close to success green to tell an active agent from a finished one.
    if (name === "running") return theme.text.feedback.warning.default;
    return theme.text.feedback[name].default;
  }

  // Runs are only visible from the session that launched them; opened outside
  // a session (home screen), the dashboard lists nothing.
  const runs = createMemo<RunSummary[]>(() =>
    props.sessionID === undefined
      ? []
      : props.store.state.runs.filter((run) => run.sessionID === props.sessionID),
  );
  const listSummary = createMemo(() => {
    const all = runs();
    const scope = props.sessionID === undefined ? "no session" : "this session";
    return `${all.length} run${all.length === 1 ? "" : "s"} · ${Format.runningCount(all)} running · ${scope}`;
  });

  // List and transcript rows share this window. Their chrome is the page
  // header, the view's own header row, three padding rows and the hint line
  // (about 7 rows), so reserving 8 fills the screen with one row of slack.
  const viewport = () => {
    now();
    return Math.max(4, props.context.renderer.terminalHeight - 8);
  };
  const columns = () => {
    now();
    return Math.max(40, props.context.renderer.terminalWidth - 6);
  };

  /**
   * Rows the two detail panels can show: the surrounding chrome (page header,
   * the run's two header lines, the panel borders and the hint row) sits
   * outside, with one row of slack so a resize never overflows the screen.
   */
  const panelBody = () => {
    now();
    return Math.max(3, props.context.renderer.terminalHeight - 11);
  };

  const groups = createMemo<Format.PhaseGroup[]>(() => {
    const current = detail();
    return current === undefined ? [] : Format.phaseGroupsOf(current);
  });
  const selectedGroup = (): Format.PhaseGroup | undefined =>
    groups()[Format.clampIndex(phaseIndex(), groups().length)];
  const phaseAgents = (): readonly AgentSummary[] => selectedGroup()?.agents ?? [];
  const selectedAgent = (): AgentSummary | undefined =>
    phaseAgents()[Format.clampIndex(agentIndex(), phaseAgents().length)];

  const listRows = createMemo<ListRow[]>(() => {
    const all = runs();
    const size = viewport();
    const start = Format.windowStart(listIndex(), size, all.length);
    return all.slice(start, start + size).map((run, offset) => ({ run, index: start + offset }));
  });

  const phaseRows = createMemo<PhaseRow[]>(() => {
    const all = groups();
    const size = panelBody();
    const start = Format.windowStart(Format.clampIndex(phaseIndex(), all.length), size, all.length);
    return all
      .slice(start, start + size)
      .map((group, offset) => ({ group, index: start + offset }));
  });

  /**
   * Trailing notes the agents pane always keeps room for: a failed run explains
   * itself, a finished one previews the result it produced.
   */
  const agentTail = (): AgentRow[] => {
    const run = detail();
    if (run === undefined) return [];
    const message = run.error;
    if (message !== undefined && message.length > 0) {
      return [
        { kind: "blank" },
        { kind: "note", text: `workflow error: ${message}`, tone: "error", arrow: false },
      ];
    }
    const json = run.resultJson;
    if (json === undefined || json.length === 0) return [];
    const preview = Format.resultPreview(json, RESULT_PREVIEW_LINES).split("\n");
    return [
      { kind: "blank" },
      { kind: "note", text: "result", tone: "subdued", arrow: false },
      ...preview.map<AgentRow>((text) => ({ kind: "note", text, tone: "default", arrow: false })),
    ];
  };

  const agentRows = createMemo<AgentRow[]>(() => {
    const tail = agentTail();
    const agents = phaseAgents();
    const size = Math.max(1, panelBody() - tail.length);
    const rows: AgentRow[] = [];
    if (agents.length === 0) {
      rows.push({
        kind: "note",
        text: "no agents in this phase yet",
        tone: "subdued",
        arrow: false,
      });
    } else {
      const cursor = Format.clampIndex(agentIndex(), agents.length);
      const start = Format.windowStart(cursor, size, agents.length);
      for (const [offset, agent] of agents.slice(start, start + size).entries()) {
        rows.push({ kind: "agent", agent, index: start + offset });
        const agentError = agent.error;
        if (agentError !== undefined && agentError.length > 0) {
          rows.push({ kind: "note", text: agentError, tone: "error", arrow: true });
        }
      }
    }
    return [...rows.slice(0, size), ...tail];
  });

  const transcriptRows = createMemo<Format.TranscriptRow[]>(() =>
    Format.transcriptRows(entries(), columns()),
  );
  const visibleTranscript = createMemo<Format.TranscriptRow[]>(() => {
    const start = Math.min(scroll(), maxScroll());
    return transcriptRows().slice(start, start + viewport());
  });

  async function loadDetail(runId: string): Promise<void> {
    try {
      setDetail(await props.port.get(runId));
      setFailure(undefined);
    } catch (cause) {
      setFailure(failureText(cause));
    }
  }

  async function refresh(): Promise<void> {
    try {
      await props.port.refresh();
      setFailure(undefined);
    } catch (cause) {
      setFailure(failureText(cause));
    }
    const current = detail();
    if (current !== undefined) await loadDetail(current.runId);
  }

  async function openDetail(run: RunSummary): Promise<void> {
    props.store.select(run.runId);
    setPhaseIndex(0);
    setAgentIndex(0);
    setDetailFocus("phases");
    setDetail(undefined);
    setView("detail");
    await loadDetail(run.runId);
  }

  function maxScroll(): number {
    return Math.max(0, transcriptRows().length - viewport());
  }

  async function openTranscript(): Promise<void> {
    const current = detail();
    const agent = selectedAgent();
    if (current === undefined || agent === undefined) return;
    setScroll(0);
    setEntries([]);
    setView("transcript");
    try {
      setEntries(await props.port.transcript(current.runId, agent.index));
      // Open at the end: the latest activity is what the reader came for.
      setScroll(maxScroll());
      setFailure(undefined);
    } catch (cause) {
      setFailure(failureText(cause));
    }
  }

  let transcriptRefreshing = false;
  /** Live re-fetch for the open transcript; follows the tail unless scrolled up. */
  async function refreshTranscript(): Promise<void> {
    if (transcriptRefreshing || view() !== "transcript") return;
    const current = detail();
    const agent = selectedAgent();
    if (current === undefined || agent === undefined) return;
    transcriptRefreshing = true;
    try {
      const next = await props.port.transcript(current.runId, agent.index);
      if (view() !== "transcript") return;
      const follow = scroll() >= maxScroll();
      setEntries(next);
      if (follow) setScroll(maxScroll());
    } catch {
      // Live refreshes are best-effort; the entries already on screen stay.
    } finally {
      transcriptRefreshing = false;
    }
  }

  function selectedRun(): RunSummary | undefined {
    if (view() === "list") return runs()[Format.clampIndex(listIndex(), runs().length)];
    return detail();
  }

  async function abortSelected(): Promise<void> {
    const run = selectedRun();
    if (run === undefined) return;
    const label = run.name ?? run.runId;
    if (run.status !== "running") {
      props.port.notify(`Workflow ${label} is not running.`, "info");
      return;
    }
    try {
      const aborted = await props.port.abort(run.runId);
      props.port.notify(
        aborted ? `Aborting workflow ${label}…` : `Workflow ${label} already settled.`,
        aborted ? "success" : "info",
      );
    } catch (cause) {
      props.port.notify(`Could not abort ${label}. ${failureText(cause)}`, "error");
    }
  }

  function scrollBy(delta: number): void {
    const max = maxScroll();
    setScroll((offset) => Math.min(max, Math.max(0, offset + delta)));
  }

  /** Move the phase cursor; the agents pane always restarts at its first row. */
  function selectPhase(index: number): void {
    setPhaseIndex(index);
    setAgentIndex(0);
  }

  function move(delta: number): void {
    const current = view();
    if (current === "list") {
      setListIndex((index) => Format.moveIndex(index, delta, runs().length));
      return;
    }
    if (current === "detail") {
      if (detailFocus() === "phases") {
        selectPhase(Format.moveIndex(phaseIndex(), delta, groups().length));
        return;
      }
      setAgentIndex((index) => Format.moveIndex(index, delta, phaseAgents().length));
      return;
    }
    scrollBy(delta);
  }

  function page(delta: number): void {
    const current = view();
    const size = Math.max(1, viewport() - 2);
    if (current === "transcript") {
      scrollBy(delta * size);
      return;
    }
    if (current === "list") {
      setListIndex((index) => Format.clampIndex(index + delta * size, runs().length));
      return;
    }
    if (detailFocus() === "phases") {
      selectPhase(Format.clampIndex(phaseIndex() + delta * size, groups().length));
      return;
    }
    setAgentIndex((index) => Format.clampIndex(index + delta * size, phaseAgents().length));
  }

  function edge(position: "top" | "bottom"): void {
    const current = view();
    if (current === "transcript") {
      setScroll(position === "top" ? 0 : maxScroll());
      return;
    }
    let count = runs().length;
    if (current === "detail") {
      count = detailFocus() === "phases" ? groups().length : phaseAgents().length;
    }
    const index = position === "top" ? 0 : Math.max(0, count - 1);
    if (current === "list") {
      setListIndex(index);
      return;
    }
    if (detailFocus() === "phases") {
      selectPhase(index);
      return;
    }
    setAgentIndex(index);
  }

  /** Hand the detail view's focus to the agents of the selected phase. */
  function focusAgents(): void {
    if (phaseAgents().length === 0) return;
    setAgentIndex((index) => Format.clampIndex(index, phaseAgents().length));
    setDetailFocus("agents");
  }

  function focusRight(): void {
    if (view() === "detail" && detailFocus() === "phases") focusAgents();
  }

  function focusLeft(): void {
    const current = view();
    if (current === "transcript") {
      back();
      return;
    }
    if (current === "detail" && detailFocus() === "agents") setDetailFocus("phases");
  }

  function confirm(): void {
    const current = view();
    if (current === "list") {
      const run = runs()[Format.clampIndex(listIndex(), runs().length)];
      if (run !== undefined) void openDetail(run);
      return;
    }
    if (current !== "detail") return;
    if (detailFocus() === "phases") {
      focusAgents();
      return;
    }
    void openTranscript();
  }

  function back(): void {
    const current = view();
    if (current === "transcript") {
      setDetailFocus("agents");
      setView("detail");
      return;
    }
    if (current === "detail") {
      if (detailFocus() === "agents") {
        setDetailFocus("phases");
        return;
      }
      setView("list");
      return;
    }
    props.close();
  }

  async function start(): Promise<void> {
    await refresh();
    const all = runs();
    const query = props.initialRunId;
    const found = query === undefined ? -1 : Format.findRunIndex(all, query);
    if (found >= 0) {
      setListIndex(found);
      const run = all[found];
      if (run !== undefined) await openDetail(run);
      return;
    }
    if (query !== undefined && query.length > 0) {
      props.port.notify(`No workflow run matched "${query}".`, "warning");
    }
    const remembered = props.store.state.selectedRunId;
    if (remembered === undefined) return;
    const at = all.findIndex((run) => run.runId === remembered);
    if (at >= 0) setListIndex(at);
  }

  props.context.keymap.layer(() => ({
    mode: DASHBOARD_MODE,
    priority: 100,
    commands: [
      {
        id: "workflows.back",
        title: "Back",
        description: "Leave the current workflows view.",
        group: "Workflows",
        bind: "escape",
        run: back,
      },
      { id: "workflows.close", bind: "q", run: () => props.close() },
      {
        id: "workflows.next",
        title: "Next item",
        group: "Workflows",
        bind: "j",
        run: () => move(1),
      },
      { id: "workflows.next-arrow", bind: "down", run: () => move(1) },
      {
        id: "workflows.previous",
        title: "Previous item",
        group: "Workflows",
        bind: "k",
        run: () => move(-1),
      },
      { id: "workflows.previous-arrow", bind: "up", run: () => move(-1) },
      {
        id: "workflows.enter",
        title: "Open selection",
        description: "Open the selected run, focus its agents, or open a transcript.",
        group: "Workflows",
        bind: "enter",
        run: confirm,
      },
      {
        id: "workflows.focus.right",
        title: "Focus agents",
        description: "Move the detail view's focus to the selected phase's agents.",
        group: "Workflows",
        bind: "l",
        run: focusRight,
      },
      { id: "workflows.focus.right-arrow", bind: "right", run: focusRight },
      {
        id: "workflows.focus.left",
        title: "Focus phases",
        description: "Move the detail view's focus back to the phases sidebar.",
        group: "Workflows",
        bind: "h",
        run: focusLeft,
      },
      { id: "workflows.focus.left-arrow", bind: "left", run: focusLeft },
      {
        id: "workflows.abort",
        title: "Abort run",
        description: "Abort the selected running workflow.",
        group: "Workflows",
        bind: "a",
        run: () => void abortSelected(),
      },
      {
        id: "workflows.refresh",
        title: "Refresh",
        description: "Re-read the workflow run list.",
        group: "Workflows",
        bind: "r",
        run: () => void refresh(),
      },
      { id: "workflows.page-down", bind: "pagedown", run: () => page(1) },
      { id: "workflows.page-up", bind: "pageup", run: () => page(-1) },
      { id: "workflows.bottom", bind: "end", run: () => edge("bottom") },
      { id: "workflows.top", bind: "home", run: () => edge("top") },
      { id: "workflows.bottom-vim", bind: "shift+g", run: () => edge("bottom") },
      {
        id: "workflows.top-vim",
        bind: "g",
        run: () => {
          const at = Date.now();
          if (at - lastTopChordAt < TOP_CHORD_WINDOW_MS) {
            lastTopChordAt = 0;
            edge("top");
            return;
          }
          lastTopChordAt = at;
        },
      },
    ],
  }));

  onMount(() => {
    const popMode = props.context.keymap.mode.push(DASHBOARD_MODE);
    const timer = setInterval(() => setNow(Date.now()), 1000);
    onCleanup(() => {
      clearInterval(timer);
      popMode();
    });

    onCleanup(
      props.port.subscribe((run) => {
        const current = detail();
        if (current === undefined || current.runId !== run.runId) return;
        void loadDetail(run.runId);
        void refreshTranscript();
      }),
    );

    void start();
  });

  function hints(): string {
    const current = view();
    if (current === "list") return "j/k select · enter open · a abort · r refresh · esc close";
    if (current === "detail") {
      return detailFocus() === "phases"
        ? "j/k phase · l/→/enter agents · a abort · r refresh · esc back"
        : "j/k agent · enter transcript · h/←/esc phases · a abort · r refresh";
    }
    return "j/k scroll · pgup/pgdn page · gg/G top/bottom · esc back";
  }

  return (
    <box flexDirection="column" flexGrow={1} paddingLeft={1} paddingRight={1} paddingTop={1}>
      <box flexDirection="row" gap={1}>
        <text fg={accent}>Workflows</text>
        <text fg={theme.text.subdued}>{listSummary()}</text>
        <box flexGrow={1} />
        <Show when={props.context.location?.directory}>
          <text fg={theme.text.subdued}>
            {props.context.ui.format.path(props.context.location?.directory ?? "")}
          </text>
        </Show>
      </box>

      <Show when={failure()} keyed>
        {(message: string) => <text fg={tone("error")}>{`error: ${message}`}</text>}
      </Show>

      <Show when={view() === "list"}>
        <box flexDirection="column" paddingTop={1}>
          <Show when={props.store.state.loaded && runs().length === 0}>
            <text fg={theme.text.subdued}>
              {props.sessionID === undefined
                ? "Open /workflows from a session to see its runs."
                : "No workflow runs in this session yet."}
            </text>
          </Show>
          <Show when={!props.store.state.loaded}>
            <text fg={theme.text.subdued}>Loading workflow runs…</text>
          </Show>
          <For each={listRows()}>
            {(row) => {
              const glyph = Format.runGlyph(row.run.status);
              return (
                <box flexDirection="row" gap={1}>
                  <text fg={accent}>{Format.marker(row.index === listIndex())}</text>
                  <text fg={tone(glyph.tone)}>{glyph.char}</text>
                  <text fg={row.index === listIndex() ? theme.text.default : theme.text.subdued}>
                    {row.run.name ?? row.run.runId}
                  </text>
                  <text fg={theme.text.subdued}>{row.run.runId}</text>
                  <box flexGrow={1} />
                  <Show when={row.run.status === "running" && row.run.currentPhase !== undefined}>
                    <text fg={theme.text.status.running}>{row.run.currentPhase ?? ""}</text>
                  </Show>
                  <text fg={theme.text.subdued}>
                    {`${Format.runProgressText(row.run)} · ${Format.runElapsedText(row.run, now())}`}
                  </text>
                  <text fg={tone(Format.runTone(row.run.status))}>
                    {Format.runStatusText(row.run.status)}
                  </text>
                </box>
              );
            }}
          </For>
        </box>
      </Show>

      <Show when={view() === "detail"}>
        <Show when={detail()} keyed fallback={<text fg={theme.text.subdued}>Loading run…</text>}>
          {(run: RunDetail) => {
            const usage = Format.runUsageText(run.agents);
            return (
              <box flexDirection="column" paddingTop={1}>
                <box flexDirection="row" gap={1}>
                  <text fg={accent} attributes={TextAttributes.BOLD}>
                    {run.name ?? run.runId}
                  </text>
                  <Show when={run.name !== undefined}>
                    <text fg={theme.text.subdued}>{run.runId}</text>
                  </Show>
                  <box flexGrow={1} />
                  <text fg={theme.text.subdued}>
                    {`${Format.runProgressText(run)} · ${Format.runElapsedText(run, now())}`}
                  </text>
                  <text fg={tone(Format.runTone(run.status))}>
                    {Format.runStatusText(run.status)}
                  </text>
                </box>
                <box flexDirection="row" gap={1}>
                  <text fg={theme.text.subdued}>{run.description ?? run.runId}</text>
                  <box flexGrow={1} />
                  <Show when={usage.length > 0}>
                    <text fg={theme.text.subdued}>{usage}</text>
                  </Show>
                </box>

                <box flexDirection="row" gap={1} paddingTop={1}>
                  <box
                    flexDirection="column"
                    width={Format.sidebarWidth(groups(), columns())}
                    height={panelBody() + 2}
                    border={true}
                    borderStyle="rounded"
                    borderColor={theme.border.default}
                    title="Phases"
                    titleColor={theme.text.subdued}
                    paddingLeft={1}
                    paddingRight={1}
                  >
                    <For each={phaseRows()}>
                      {(row) => {
                        const glyph = Format.phaseGlyph(row.group.state);
                        return (
                          // Spacing is baked into the cells instead of flex gaps:
                          // on rows that exactly fill the sidebar, the layout
                          // engine collapses gaps before it truncates text.
                          <box flexDirection="row">
                            <text
                              flexShrink={0}
                              fg={detailFocus() === "phases" ? accent : theme.text.subdued}
                            >
                              {`${Format.marker(row.index === phaseIndex())} `}
                            </text>
                            <text flexShrink={0} fg={tone(glyph.tone)}>
                              {`${glyph.char} `}
                            </text>
                            <text
                              fg={
                                row.index === phaseIndex() && detailFocus() === "phases"
                                  ? accent
                                  : theme.text.default
                              }
                            >
                              {row.group.title}
                            </text>
                            <box flexGrow={1} minWidth={1} />
                            <text flexShrink={0} fg={theme.text.subdued}>
                              {Format.phaseProgressText(row.group)}
                            </text>
                          </box>
                        );
                      }}
                    </For>
                    <Show when={groups().length === 0}>
                      <text fg={theme.text.subdued}>no phases yet</text>
                    </Show>
                  </box>

                  <box
                    flexDirection="column"
                    flexGrow={1}
                    height={panelBody() + 2}
                    border={true}
                    borderStyle="rounded"
                    borderColor={theme.border.default}
                    title={Format.agentsPanelTitle(selectedGroup())}
                    titleColor={theme.text.subdued}
                    paddingLeft={1}
                    paddingRight={1}
                  >
                    <For each={agentRows()}>
                      {(row) => {
                        if (row.kind === "blank") {
                          return <text fg={theme.text.subdued}> </text>;
                        }
                        if (row.kind === "note") {
                          return (
                            <box flexDirection="row" gap={1} paddingLeft={row.arrow ? 2 : 0}>
                              <Show when={row.arrow}>
                                <text fg={theme.text.subdued}>{Format.CONTINUATION}</text>
                              </Show>
                              <text fg={tone(row.tone)}>{row.text}</text>
                            </box>
                          );
                        }

                        const selected = row.index === agentIndex() && detailFocus() === "agents";
                        const glyph = Format.agentGlyph(row.agent.state);
                        const modelText = Format.agentModelText(row.agent);
                        return (
                          <box flexDirection="row">
                            <text flexShrink={0} fg={accent}>
                              {`${Format.marker(selected)} `}
                            </text>
                            <text flexShrink={0} fg={tone(glyph.tone)}>
                              {`${glyph.char} `}
                            </text>
                            <text fg={selected ? accent : theme.text.default}>
                              {row.agent.label.padEnd(Format.agentLabelWidth(phaseAgents()))}
                            </text>
                            <Show when={modelText.length > 0}>
                              <text fg={theme.text.subdued}>{` ${modelText}`}</text>
                            </Show>
                            <box flexGrow={1} minWidth={1} />
                            <text flexShrink={0} fg={theme.text.subdued}>
                              {Format.agentElapsedText(row.agent, now())}
                            </text>
                          </box>
                        );
                      }}
                    </For>
                  </box>
                </box>
              </box>
            );
          }}
        </Show>
      </Show>

      <Show when={view() === "transcript"}>
        <box flexDirection="column" paddingTop={1}>
          <Show when={selectedAgent()} keyed>
            {(agent: AgentSummary) => {
              const glyph = Format.agentGlyph(agent.state);
              return (
                <box flexDirection="row" gap={1}>
                  <text fg={tone(glyph.tone)}>{glyph.char}</text>
                  <text fg={accent}>{agent.label}</text>
                  <text fg={theme.text.subdued}>{agent.phase ?? Format.UNPHASED}</text>
                  <box flexGrow={1} />
                  <text fg={theme.text.subdued}>
                    {`${Format.agentStatsText(agent, now())} · ${transcriptRows().length} rows`}
                  </text>
                </box>
              );
            }}
          </Show>
          <box flexDirection="column" paddingTop={1}>
            <For each={visibleTranscript()}>
              {(row) => <text fg={tone(row.tone)}>{row.text.length === 0 ? " " : row.text}</text>}
            </For>
          </box>
        </box>
      </Show>

      <box flexGrow={1} />
      <box flexDirection="row" paddingTop={1}>
        <text fg={theme.text.subdued}>{hints()}</text>
      </box>
    </box>
  );
}
