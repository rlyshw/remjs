/**
 * Synth-flag — a module-scoped counter that marks when the player is
 * synchronously dispatching a synthetic event. Both the recorder's
 * event-capture wrapper and the player's strict-events filter read
 * this flag to distinguish player-originated dispatches from
 * environmental input.
 *
 * The counter form (rather than a boolean) preserves correctness
 * under reentrant dispatch: if a handler invoked by `applyEvent`
 * itself calls back into `player.apply`, `enter`/`exit` bracketing
 * keeps the active state accurate.
 *
 * See `docs/MULTIWRITER_MODEL.md` for the invariant this supports.
 */

let depth = 0;

export function enterSynth(): void {
  depth++;
}

export function exitSynth(): void {
  if (depth > 0) depth--;
}

export function isSynthActive(): boolean {
  return depth > 0;
}

/** Test-only: reset the counter. Never call outside tests. */
export function _resetSynthFlag(): void {
  depth = 0;
}
