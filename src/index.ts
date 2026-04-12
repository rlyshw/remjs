/**
 * remjs v0.3 — Event Loop Replication
 *
 * Serializes JavaScript program execution by capturing event loop inputs
 * (DOM events, timers, network, randomness, clock) as structured ops.
 * Replay the same ops on another runtime to produce identical execution.
 *
 * Where remdom reifies the DOM output surface, remjs reifies the
 * event loop input surface. Together: full round-trip replication.
 */

// Op types
export type {
  Op,
  EventOp,
  TimerOp,
  NetworkOp,
  RandomOp,
  ClockOp,
  StorageOp,
  NavigationOp,
  SnapshotOp,
  PendingTimer,
  PendingNetwork,
} from "./ops.js";

// Codec
export { jsonCodec } from "./codec.js";
export type { Codec } from "./codec.js";

// Recorder
export { createRecorder } from "./recorder.js";
export type { Recorder, RecorderOptions, BatchMode } from "./recorder.js";

// Player
export { createPlayer } from "./player.js";
export type { Player, PlayerOptions, ReplayMode } from "./player.js";
