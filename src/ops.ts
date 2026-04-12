/**
 * remjs v0.3 — Event Loop Op Protocol
 *
 * Each op captures one event loop input: something that entered the JS
 * runtime from the environment. The complete input surface is covered:
 * DOM events, timer fires, network responses, non-deterministic values
 * (random, clock), storage access, and navigation.
 *
 * All ops are plain JSON — no tagged values, no __remjs encoding.
 * The event loop input surface is made of primitives, strings, and
 * simple structures that survive JSON round-trip without special handling.
 *
 * Every op carries an optional `ts` field — the wall clock time
 * (performance.now or Date.now) when the op was recorded. This enables
 * temporal replay: ops are replayed at their original cadence rather
 * than all at once.
 */

/* ── DOM Events ─────────────────────────────────────────────────── */

export interface EventOp {
  type: "event";
  ts?: number;
  eventType: string;
  targetPath: string;
  timestamp: number;
  detail: Record<string, unknown>;
}

/* ── Timer Fires ────────────────────────────────────────────────── */

export interface TimerOp {
  type: "timer";
  ts?: number;
  kind: "timeout" | "interval" | "raf" | "idle";
  seq: number;
  scheduledDelay: number;
  actualTime: number;
}

/* ── Network Responses ──────────────────────────────────────────── */

export interface NetworkOp {
  type: "network";
  ts?: number;
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
  source: "math" | "crypto";
  values: number[];
}

/* ── Non-determinism: Clock ─────────────────────────────────────── */

export interface ClockOp {
  type: "clock";
  ts?: number;
  source: "dateNow" | "performanceNow" | "dateConstructor";
  value: number;
}

/* ── Storage ────────────────────────────────────────────────────── */

export interface StorageOp {
  type: "storage";
  ts?: number;
  kind: "local" | "session";
  action: "get" | "set" | "remove";
  key: string;
  value: string | null;
}

/* ── Navigation ─────────────────────────────────────────────────── */

export interface NavigationOp {
  type: "navigation";
  ts?: number;
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
