/**
 * One subscription to the opencode event stream, fanned out to per-session
 * listeners. Workflow child agents register here to learn about activity
 * (progress refresh triggers) and terminal execution events.
 */

import { z } from "zod";

const eventSchema = z.object({
  type: z.string().catch(""),
  data: z
    .object({
      sessionID: z.string().catch(""),
      error: z
        .object({ message: z.string().catch("") })
        .optional()
        .catch(undefined),
      reason: z.string().optional().catch(undefined),
    })
    .catch({ sessionID: "" }),
});

const ACTIVITY_PREFIXES = ["session.message.", "session.step.", "session.tool.", "session.text."];

export type ChildSettleStatus = "succeeded" | "failed" | "interrupted";

export interface ChildSessionListener {
  onActivity(): void;
  onSettled(status: ChildSettleStatus, error?: string): void;
}

export interface SessionEventHub {
  /** Route one raw opencode event; safe to call with anything. */
  dispatch(event: unknown): void;
  register(sessionID: string, listener: ChildSessionListener): () => void;
}

export function createSessionEventHub(): SessionEventHub {
  const listeners = new Map<string, Set<ChildSessionListener>>();
  return {
    dispatch(event: unknown) {
      const decoded = eventSchema.safeParse(event);
      if (!decoded.success) return;
      const { type, data } = decoded.data;
      if (data.sessionID === "") return;
      const targets = listeners.get(data.sessionID);
      if (!targets) return;
      if (type === "session.execution.succeeded") {
        for (const listener of targets) listener.onSettled("succeeded");
        return;
      }
      if (type === "session.execution.failed") {
        const message = data.error?.message;
        for (const listener of targets) {
          listener.onSettled("failed", message || undefined);
        }
        return;
      }
      if (type === "session.execution.interrupted") {
        for (const listener of targets) {
          listener.onSettled(
            "interrupted",
            data.reason ? `interrupted (${data.reason})` : undefined,
          );
        }
        return;
      }
      if (ACTIVITY_PREFIXES.some((prefix) => type.startsWith(prefix))) {
        for (const listener of targets) listener.onActivity();
      }
    },
    register(sessionID, listener) {
      const targets = listeners.get(sessionID) ?? new Set();
      targets.add(listener);
      listeners.set(sessionID, targets);
      return () => {
        targets.delete(listener);
        if (targets.size === 0) listeners.delete(sessionID);
      };
    },
  };
}
