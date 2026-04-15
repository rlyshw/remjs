/**
 * Op types — one per event loop input kind.
 *
 * Every op carries an optional `ts` (performance.now at record time)
 * that the player uses for temporal replay: scheduling replayed triggers
 * at their original relative cadence instead of all at once.
 */

/* ── DOM Events ─────────────────────────────────────────────────── */

export interface EventOp {
  type: "event";
  ts?: number;
  /**
   * Optional identifier of the peer that produced this op. Stamped by
   * the recorder when `createRecorder({ peer })` is set; absent
   * otherwise. The framework never inspects this — it's metadata for
   * consumers doing multi-writer routing, echo dedup, or consensus.
   */
  peer?: string;
  eventType: string;
  targetPath: string;
  timestamp: number;
  detail: Record<string, unknown>;
}

/* ── Timer Fires ────────────────────────────────────────────────── */

export interface TimerOp {
  type: "timer";
  ts?: number;
  peer?: string;
  kind: "timeout" | "interval" | "raf" | "idle";
  seq: number;
  scheduledDelay: number;
  actualTime: number;
}

/* ── Network Responses ──────────────────────────────────────────── */

export interface NetworkOp {
  type: "network";
  ts?: number;
  peer?: string;
  kind: "fetch" | "xhr" | "websocket";
  seq: number;
  url: string;
  method?: string;
  status?: number;
  headers?: Record<string, string>;
  body: string | null;
}

/* ── Non-determinism: Random ────────────────────────────────────── */

export interface RandomOp {
  type: "random";
  ts?: number;
  peer?: string;
  source: "math" | "crypto";
  values: number[];
}

/* ── Non-determinism: Clock ─────────────────────────────────────── */

export interface ClockOp {
  type: "clock";
  ts?: number;
  peer?: string;
  source: "dateNow" | "performanceNow" | "dateConstructor";
  value: number;
}

/* ── Storage ────────────────────────────────────────────────────── */

export interface StorageOp {
  type: "storage";
  ts?: number;
  peer?: string;
  kind: "local" | "session";
  action: "get" | "set" | "remove";
  key: string;
  value: string | null;
}

/* ── Navigation ─────────────────────────────────────────────────── */

export interface NavigationOp {
  type: "navigation";
  ts?: number;
  peer?: string;
  kind: "popstate" | "hashchange" | "pushState" | "replaceState";
  url: string;
  state?: unknown;
}

/* ── Snapshot ────────────────────────────────────────────────────── */

export interface PendingTimer {
  seq: number;
  kind: string;
  remainingDelay: number;
}

export interface PendingNetwork {
  seq: number;
  url: string;
  method: string;
}

export interface SnapshotOp {
  type: "snapshot";
  ts?: number;
  peer?: string;
  html: string;
  url: string;
  timestamp: number;
  pendingTimers: PendingTimer[];
  pendingNetwork: PendingNetwork[];
}

/* ── Union ──────────────────────────────────────────────────────── */

export type Op =
  | EventOp
  | TimerOp
  | NetworkOp
  | RandomOp
  | ClockOp
  | StorageOp
  | NavigationOp
  | SnapshotOp;
