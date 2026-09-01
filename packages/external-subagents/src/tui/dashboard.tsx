import type { Plugin } from "@opencode-ai/plugin/tui";
import { TextAttributes } from "@opentui/core";
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import type { JSX } from "solid-js";
import type {
  ExternalSubagentDetail,
  ExternalSubagentSummary,
  ExternalSubagentTranscript,
} from "../rpc.ts";
import * as Format from "./format.ts";
import type { StatusStore } from "./status.ts";

export const DASHBOARD_MODE = "external-subagents";

const TOP_CHORD_WINDOW_MS = 600;
const PREVIEW_LINES = 8;

type View = "list" | "detail" | "transcript";
type Notice = "info" | "success" | "warning" | "error";

export interface DashboardPort {
  refresh(): Promise<void>;
  get(handle: string, sessionID: string): Promise<ExternalSubagentDetail>;
  transcript(handle: string, sessionID: string): Promise<ExternalSubagentTranscript>;
  subscribe(handler: (handle?: string) => void): () => void;
  notify(message: string, variant: Notice): void;
}

interface DashboardProps {
  readonly context: Plugin.Context;
  readonly store: StatusStore;
  readonly port: DashboardPort;
  readonly close: () => void;
  readonly initialHandle?: string;
  readonly sessionID?: string;
}

interface ListRow {
  readonly run: ExternalSubagentSummary;
  readonly index: number;
}

interface DetailRow {
  readonly text: string;
  readonly tone: Format.Tone;
}

const EMPTY_TRANSCRIPT: ExternalSubagentTranscript = { entries: [], liveTools: [] };

function failureText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function ExternalSubagentsDashboard(props: DashboardProps): JSX.Element {
  const theme = props.context.theme;
  const accent = theme.text.action.primary.default;

  const [view, setView] = createSignal<View>("list");
  const [listIndex, setListIndex] = createSignal(0);
  const [listHandle, setListHandle] = createSignal<string>();
  const [openHandle, setOpenHandle] = createSignal<string>();
  const [detail, setDetail] = createSignal<ExternalSubagentDetail>();
  const [detailScroll, setDetailScroll] = createSignal(0);
  const [transcript, setTranscript] = createSignal<ExternalSubagentTranscript>(EMPTY_TRANSCRIPT);
  const [scroll, setScroll] = createSignal(0);
  const [listFailure, setListFailure] = createSignal<string>();
  const [detailFailure, setDetailFailure] = createSignal<string>();
  const [transcriptFailure, setTranscriptFailure] = createSignal<string>();
  // A one-second render tick keeps session ages and terminal dimensions fresh.
  const [now, setNow] = createSignal(Date.now());
  let lastTopChordAt = 0;
  let disposed = false;
  let startGeneration = 0;
  let detailGeneration = 0;
  let transcriptGeneration = 0;

  function tone(name: Format.Tone) {
    if (name === "default") return theme.text.default;
    if (name === "subdued") return theme.text.subdued;
    if (name === "running") return theme.text.feedback.warning.default;
    return theme.text.feedback[name].default;
  }

  const runs = (): ExternalSubagentSummary[] =>
    props.sessionID === undefined
      ? []
      : props.store.state.runs.filter((run) => run.sessionID === props.sessionID);

  const failure = createMemo(() => {
    if (view() === "transcript") {
      return transcriptFailure() ?? detailFailure() ?? listFailure();
    }
    if (view() === "detail") return detailFailure() ?? listFailure();
    return listFailure();
  });

  const listSummary = createMemo(() => {
    const all = runs();
    const scope = props.sessionID === undefined ? "no session" : "this session";
    return `${all.length} session${all.length === 1 ? "" : "s"} · ${Format.runningCount(all)} running · ${Format.queuedCount(all)} queued · ${scope}`;
  });

  const viewport = () => {
    now();
    return Math.max(4, props.context.renderer.terminalHeight - 8);
  };
  const columns = () => {
    now();
    return Math.max(40, props.context.renderer.terminalWidth - 6);
  };

  const listRows = createMemo<ListRow[]>(() => {
    const all = runs();
    const size = viewport();
    const start = Format.windowStart(listIndex(), size, all.length);
    return all.slice(start, start + size).map((run, offset) => ({ run, index: start + offset }));
  });

  function appendPreview(
    rows: DetailRow[],
    label: string,
    value: string,
    bodyTone: Format.Tone = "default",
  ): void {
    rows.push({ text: label, tone: "subdued" });
    const wrapped: DetailRow[] = [];
    for (const line of Format.sanitizeText(value).split("\n")) {
      for (const text of Format.wrapLine(line, columns() - 2)) {
        wrapped.push({ text: `  ${text}`, tone: bodyTone });
      }
    }
    rows.push(...wrapped.slice(0, PREVIEW_LINES));
    if (wrapped.length > PREVIEW_LINES) {
      rows.push({ text: `  …${wrapped.length - PREVIEW_LINES} more rows`, tone: "subdued" });
    }
  }

  const detailRows = createMemo<DetailRow[]>(() => {
    const run = detail();
    if (run === undefined) return [];
    const rows: DetailRow[] = [];
    const context = Format.contextText(run);
    rows.push({
      text: `backend/model  ${Format.backendModelText(run)}`,
      tone: "default",
    });
    rows.push({
      text: `session age   ${Format.sessionAgeText(run, now())} · ${run.turns} turn${run.turns === 1 ? "" : "s"} · ${context}`,
      tone: "default",
    });
    rows.push({
      text: `compaction    ${run.compacting ? "in progress" : "idle"} · ${run.compactionCount} completed`,
      tone: run.compacting ? "running" : "subdued",
    });
    rows.push({
      text: `working dir   ${props.context.ui.format.path(run.cwd)}`,
      tone: "subdued",
    });
    if (run.nativeSessionId !== undefined) {
      rows.push({ text: `native ID     ${run.nativeSessionId}`, tone: "subdued" });
    }
    if (run.sessionFilePath !== undefined) {
      rows.push({
        text: `transcript    ${props.context.ui.format.path(run.sessionFilePath)}`,
        tone: "subdued",
      });
    }
    if (run.sessionTitle !== run.title) {
      rows.push({ text: `session title ${run.sessionTitle}`, tone: "subdued" });
    }
    rows.push({ text: "", tone: "subdued" });
    appendPreview(rows, "PROMPT", run.prompt);
    if (run.errorText !== undefined && run.errorText.length > 0) {
      rows.push({ text: "", tone: "subdued" });
      let label = "DIAGNOSTIC";
      let bodyTone: Format.Tone = "warning";
      if (run.status === "error") {
        label = run.cancelled ? "ABORTED" : "ERROR";
        bodyTone = "error";
      }
      appendPreview(rows, label, run.errorText, bodyTone);
    }
    if (run.queued.length > 0) {
      rows.push({ text: "", tone: "subdued" });
      rows.push({ text: `QUEUED MESSAGES · ${run.queued.length}`, tone: "warning" });
      for (const message of run.queued) {
        appendPreview(rows, message.kind.toUpperCase(), message.text, "subdued");
      }
    }
    if (run.liveTools.length > 0) {
      rows.push({ text: "", tone: "subdued" });
      rows.push({ text: `ACTIVE TOOLS · ${run.liveTools.length}`, tone: "running" });
      for (const tool of run.liveTools) {
        const body = [tool.argsPreview, tool.outputPreview].filter(Boolean).join("\n");
        appendPreview(rows, `TOOL ${tool.name}`, body || "(running)", "subdued");
      }
    }
    const latest = run.liveAssistant?.text.trim() || run.finalText;
    if (run.liveAssistant?.thinking.trim()) {
      rows.push({ text: "", tone: "subdued" });
      appendPreview(rows, "LIVE THINKING", run.liveAssistant.thinking, "subdued");
    }
    if (latest.trim()) {
      rows.push({ text: "", tone: "subdued" });
      appendPreview(rows, run.liveAssistant?.text.trim() ? "LIVE OUTPUT" : "LATEST OUTPUT", latest);
    }
    return rows;
  });

  const maxDetailScroll = () => Math.max(0, detailRows().length - viewport());
  const visibleDetail = createMemo(() => {
    const start = Math.min(detailScroll(), maxDetailScroll());
    return detailRows().slice(start, start + viewport());
  });

  const transcriptRows = createMemo(() => Format.transcriptRows(transcript(), columns()));
  const maxScroll = () => Math.max(0, transcriptRows().length - viewport());
  const visibleTranscript = createMemo(() => {
    const start = Math.min(scroll(), maxScroll());
    return transcriptRows().slice(start, start + viewport());
  });

  let detailRefreshPending = false;
  let detailRefreshInFlight: Promise<void> | undefined;

  function invalidateDetail(): void {
    detailGeneration++;
    detailRefreshPending = false;
  }

  function loadDetail(handle: string): Promise<void> {
    if (disposed || openHandle() !== handle) return Promise.resolve();
    detailRefreshPending = true;
    if (detailRefreshInFlight !== undefined) return detailRefreshInFlight;

    detailRefreshInFlight = (async () => {
      while (detailRefreshPending && !disposed) {
        detailRefreshPending = false;
        const generation = detailGeneration;
        const requestedHandle = openHandle();
        const sessionID = props.sessionID;
        if (requestedHandle === undefined || sessionID === undefined) return;
        try {
          const next = await props.port.get(requestedHandle, sessionID);
          if (disposed || generation !== detailGeneration || openHandle() !== requestedHandle) {
            continue;
          }
          setDetail(next);
          setDetailFailure(undefined);
        } catch (cause) {
          if (disposed || generation !== detailGeneration || openHandle() !== requestedHandle) {
            continue;
          }
          setDetailFailure(failureText(cause));
        }
      }
    })().finally(() => {
      detailRefreshInFlight = undefined;
      const handle = openHandle();
      if (detailRefreshPending && !disposed && handle !== undefined) {
        void loadDetail(handle);
      }
    });
    return detailRefreshInFlight;
  }

  async function refresh(): Promise<void> {
    lastTopChordAt = 0;
    try {
      await props.port.refresh();
      if (disposed) return;
      setListFailure(undefined);
    } catch (cause) {
      if (disposed) return;
      setListFailure(failureText(cause));
    }
    reconcileRuns();
    const current = openHandle();
    if (current !== undefined) await loadDetail(current);
    if (view() === "transcript") await refreshTranscript(true);
  }

  async function openDetail(run: ExternalSubagentSummary): Promise<void> {
    startGeneration++;
    invalidateDetail();
    invalidateTranscript();
    props.store.select(run.id);
    setListHandle(run.id);
    setListIndex(
      Math.max(
        0,
        runs().findIndex((candidate) => candidate.id === run.id),
      ),
    );
    setOpenHandle(run.id);
    setDetailScroll(0);
    setDetail(undefined);
    setDetailFailure(undefined);
    setTranscript(EMPTY_TRANSCRIPT);
    setTranscriptFailure(undefined);
    changeView("detail");
    await loadDetail(run.id);
  }

  async function openTranscript(): Promise<void> {
    const run = detail();
    if (run === undefined || props.sessionID === undefined || openHandle() !== run.id) return;
    invalidateTranscript();
    setScroll(0);
    setTranscript(EMPTY_TRANSCRIPT);
    setTranscriptFailure(undefined);
    changeView("transcript");
    await refreshTranscript(true);
  }

  let transcriptRefreshing = false;
  let transcriptRefreshPending = false;
  let transcriptShouldReportFailure = false;

  function invalidateTranscript(): void {
    transcriptGeneration++;
    transcriptRefreshPending = false;
    transcriptShouldReportFailure = false;
  }

  async function refreshTranscript(reportFailure = false): Promise<void> {
    if (disposed || view() !== "transcript") return;
    transcriptRefreshPending = true;
    transcriptShouldReportFailure ||= reportFailure;
    if (transcriptRefreshing) return;
    transcriptRefreshing = true;
    try {
      while (transcriptRefreshPending && view() === "transcript" && !disposed) {
        transcriptRefreshPending = false;
        const generation = transcriptGeneration;
        const handle = openHandle();
        const sessionID = props.sessionID;
        if (handle === undefined || sessionID === undefined) return;
        try {
          const next = await props.port.transcript(handle, sessionID);
          if (
            disposed ||
            generation !== transcriptGeneration ||
            view() !== "transcript" ||
            openHandle() !== handle
          ) {
            continue;
          }
          const follow = scroll() >= maxScroll();
          setTranscript(next);
          if (follow) setScroll(maxScroll());
          setTranscriptFailure(undefined);
          transcriptShouldReportFailure = false;
        } catch (cause) {
          if (
            disposed ||
            generation !== transcriptGeneration ||
            view() !== "transcript" ||
            openHandle() !== handle
          ) {
            continue;
          }
          // Streaming refresh is best-effort; retain the rows already on screen.
          if (transcriptShouldReportFailure) setTranscriptFailure(failureText(cause));
          transcriptShouldReportFailure = false;
        }
      }
    } finally {
      transcriptRefreshing = false;
      if (transcriptRefreshPending && !disposed && view() === "transcript") {
        void refreshTranscript(transcriptShouldReportFailure);
      }
    }
  }

  function changeView(next: View): void {
    lastTopChordAt = 0;
    setView(next);
  }

  function selectRunAt(index: number): void {
    const all = runs();
    const next = Format.clampIndex(index, all.length);
    setListIndex(next);
    setListHandle(all[next]?.id);
  }

  function clearOpenRun(): void {
    invalidateDetail();
    invalidateTranscript();
    setOpenHandle(undefined);
    setDetail(undefined);
    setDetailFailure(undefined);
    setTranscript(EMPTY_TRANSCRIPT);
    setTranscriptFailure(undefined);
    setDetailScroll(0);
    setScroll(0);
  }

  function scrollBy(delta: number): void {
    if (view() === "detail") {
      setDetailScroll((offset) => Math.min(maxDetailScroll(), Math.max(0, offset + delta)));
      return;
    }
    setScroll((offset) => Math.min(maxScroll(), Math.max(0, offset + delta)));
  }

  function move(delta: number): void {
    startGeneration++;
    lastTopChordAt = 0;
    if (view() === "list") {
      selectRunAt(Format.moveIndex(listIndex(), delta, runs().length));
      return;
    }
    scrollBy(delta);
  }

  function page(delta: number): void {
    startGeneration++;
    lastTopChordAt = 0;
    const size = Math.max(1, viewport() - 2);
    if (view() === "list") {
      selectRunAt(listIndex() + delta * size);
      return;
    }
    scrollBy(delta * size);
  }

  function edge(position: "top" | "bottom"): void {
    startGeneration++;
    lastTopChordAt = 0;
    if (view() === "list") {
      selectRunAt(position === "top" ? 0 : Math.max(0, runs().length - 1));
      return;
    }
    if (view() === "detail") {
      setDetailScroll(position === "top" ? 0 : maxDetailScroll());
      return;
    }
    setScroll(position === "top" ? 0 : maxScroll());
  }

  function confirm(): void {
    startGeneration++;
    lastTopChordAt = 0;
    if (view() === "list") {
      const all = runs();
      const selected = listHandle();
      const run =
        (selected === undefined ? undefined : all.find((candidate) => candidate.id === selected)) ??
        all[Format.clampIndex(listIndex(), all.length)];
      if (run !== undefined) void openDetail(run);
      return;
    }
    if (view() === "detail") void openTranscript();
  }

  function focusRight(): void {
    confirm();
  }

  function focusLeft(): void {
    lastTopChordAt = 0;
    if (view() !== "list") back();
  }

  function back(): void {
    if (view() === "transcript") {
      invalidateTranscript();
      changeView("detail");
      return;
    }
    if (view() === "detail") {
      clearOpenRun();
      changeView("list");
      return;
    }
    close();
  }

  function close(): void {
    lastTopChordAt = 0;
    startGeneration++;
    invalidateDetail();
    invalidateTranscript();
    props.close();
  }

  async function start(): Promise<void> {
    const generation = ++startGeneration;
    await refresh();
    if (disposed || generation !== startGeneration) return;
    const all = runs();
    const query = props.initialHandle;
    const found = query === undefined ? -1 : Format.findSubagentIndex(all, query);
    if (found >= 0) {
      selectRunAt(found);
      const run = all[found];
      if (run !== undefined) await openDetail(run);
      return;
    }
    if (query !== undefined && query.length > 0) {
      if (disposed || generation !== startGeneration) return;
      props.port.notify(`No external session matched "${query}".`, "warning");
    }
    const remembered = props.store.state.selectedHandle;
    if (remembered === undefined) return;
    const at = all.findIndex((run) => run.id === remembered);
    if (at >= 0) selectRunAt(at);
  }

  function reconcileRuns(): void {
    const all = runs();
    const selected = listHandle();
    const selectedAt =
      selected === undefined ? -1 : all.findIndex((candidate) => candidate.id === selected);
    if (selectedAt >= 0) {
      if (selectedAt !== listIndex()) setListIndex(selectedAt);
    } else {
      selectRunAt(listIndex());
    }

    const current = openHandle();
    if (current !== undefined && !all.some((run) => run.id === current)) {
      clearOpenRun();
      changeView("list");
    }
  }

  createEffect(reconcileRuns);

  props.context.keymap.layer(() => ({
    mode: DASHBOARD_MODE,
    priority: 100,
    commands: [
      {
        id: "external-subagents.back",
        title: "Back",
        description: "Leave the current external subagents view.",
        group: "External subagents",
        bind: "escape",
        run: back,
      },
      { id: "external-subagents.close", bind: "q", run: close },
      {
        id: "external-subagents.next",
        title: "Next item",
        group: "External subagents",
        bind: "j",
        run: () => move(1),
      },
      { id: "external-subagents.next-arrow", bind: "down", run: () => move(1) },
      {
        id: "external-subagents.previous",
        title: "Previous item",
        group: "External subagents",
        bind: "k",
        run: () => move(-1),
      },
      { id: "external-subagents.previous-arrow", bind: "up", run: () => move(-1) },
      {
        id: "external-subagents.open-selection",
        title: "Open selection",
        description: "Open the selected external session or its transcript.",
        group: "External subagents",
        bind: "enter",
        run: confirm,
      },
      { id: "external-subagents.right", bind: "l", run: focusRight },
      { id: "external-subagents.right-arrow", bind: "right", run: focusRight },
      { id: "external-subagents.left", bind: "h", run: focusLeft },
      { id: "external-subagents.left-arrow", bind: "left", run: focusLeft },
      {
        id: "external-subagents.refresh",
        title: "Refresh",
        description: "Re-read external sessions and the open view.",
        group: "External subagents",
        bind: "r",
        run: () => void refresh(),
      },
      { id: "external-subagents.page-down", bind: "pagedown", run: () => page(1) },
      { id: "external-subagents.page-up", bind: "pageup", run: () => page(-1) },
      { id: "external-subagents.bottom", bind: "end", run: () => edge("bottom") },
      { id: "external-subagents.top", bind: "home", run: () => edge("top") },
      { id: "external-subagents.bottom-vim", bind: "shift+g", run: () => edge("bottom") },
      {
        id: "external-subagents.top-vim",
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

  onCleanup(() => {
    disposed = true;
    startGeneration++;
    invalidateDetail();
    invalidateTranscript();
  });

  onMount(() => {
    const popMode = props.context.keymap.mode.push(DASHBOARD_MODE);
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    onCleanup(() => {
      clearInterval(timer);
      popMode();
    });
    onCleanup(
      props.port.subscribe((handle) => {
        if (disposed) return;
        reconcileRuns();
        const current = openHandle();
        if (current === undefined || (handle !== undefined && current !== handle)) return;
        void loadDetail(current);
        void refreshTranscript();
      }),
    );
    void start();
  });

  function hints(): string {
    if (view() === "list") return "j/k select · enter/l open · r refresh · esc/q close";
    if (view() === "detail") {
      return "j/k scroll · enter/l transcript · h/esc back · r refresh · q close";
    }
    return "j/k scroll · pgup/pgdn page · gg/G top/bottom · h/esc back · q close";
  }

  return (
    <box flexDirection="column" flexGrow={1} paddingLeft={1} paddingRight={1} paddingTop={1}>
      <box flexDirection="row" gap={1}>
        <text fg={accent}>External subagents</text>
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
          <Show when={!props.store.state.loaded}>
            <text fg={theme.text.subdued}>Loading external sessions…</text>
          </Show>
          <Show when={props.store.state.loaded && runs().length === 0}>
            <text fg={theme.text.subdued}>
              {props.sessionID === undefined
                ? "Open /subagents from a session to inspect its external runs."
                : "No Claude Code or Codex runs in this session yet."}
            </text>
          </Show>
          <For each={listRows()}>
            {(row) => {
              const status = Format.displayStatus(row.run.status, row.run.cancelled);
              const glyph = Format.statusGlyph(status);
              const activity = [
                row.run.liveToolCount > 0 ? `${row.run.liveToolCount} tools` : undefined,
                row.run.queuedCount > 0 ? `${row.run.queuedCount} messages queued` : undefined,
              ]
                .filter(Boolean)
                .join(" · ");
              return (
                <box flexDirection="row" gap={1}>
                  <text fg={accent}>{Format.marker(row.index === listIndex())}</text>
                  <text fg={tone(glyph.tone)}>{glyph.char}</text>
                  <text fg={row.index === listIndex() ? theme.text.default : theme.text.subdued}>
                    {row.run.title}
                  </text>
                  <text fg={theme.text.subdued}>{row.run.id}</text>
                  <box flexGrow={1} />
                  <Show when={activity.length > 0}>
                    <text fg={tone("running")}>{activity}</text>
                  </Show>
                  <text fg={theme.text.subdued}>
                    {`${Format.backendModelText(row.run)} · ${row.run.turns} turn${row.run.turns === 1 ? "" : "s"} · age ${Format.sessionAgeText(row.run, now())}`}
                  </text>
                  <text fg={tone(Format.statusTone(status))}>{status}</text>
                </box>
              );
            }}
          </For>
        </box>
      </Show>

      <Show when={view() === "detail"}>
        <Show
          when={detail()}
          keyed
          fallback={<text fg={theme.text.subdued}>Loading session…</text>}
        >
          {(run: ExternalSubagentDetail) => {
            const status = Format.displayStatus(run.status, run.cancelled);
            const glyph = Format.statusGlyph(status);
            return (
              <box flexDirection="column" paddingTop={1}>
                <box flexDirection="row" gap={1}>
                  <text fg={tone(glyph.tone)}>{glyph.char}</text>
                  <text fg={accent} attributes={TextAttributes.BOLD}>
                    {run.title}
                  </text>
                  <text fg={theme.text.subdued}>{run.id}</text>
                  <box flexGrow={1} />
                  <text fg={tone(Format.statusTone(status))}>{status}</text>
                </box>
                <box flexDirection="column" paddingTop={1}>
                  <For each={visibleDetail()}>
                    {(row) => (
                      <text fg={tone(row.tone)}>{row.text.length === 0 ? " " : row.text}</text>
                    )}
                  </For>
                </box>
              </box>
            );
          }}
        </Show>
      </Show>

      <Show when={view() === "transcript"}>
        <box flexDirection="column" paddingTop={1}>
          <Show when={detail()} keyed>
            {(run: ExternalSubagentDetail) => {
              const status = Format.displayStatus(run.status, run.cancelled);
              const glyph = Format.statusGlyph(status);
              return (
                <box flexDirection="row" gap={1}>
                  <text fg={tone(glyph.tone)}>{glyph.char}</text>
                  <text fg={accent}>{run.title}</text>
                  <text fg={theme.text.subdued}>{run.id}</text>
                  <box flexGrow={1} />
                  <text fg={theme.text.subdued}>
                    {`${Format.backendModelText(run)} · ${transcriptRows().length} rows`}
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
