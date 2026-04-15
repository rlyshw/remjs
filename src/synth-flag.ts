/**
 * Synth-flag — marks when the player is synchronously dispatching a
 * synthetic event. The recorder skips emit and the strict-events filter
 * passes trusted events through while this flag is active.
 *
 * Counter rather than boolean: reentrant dispatch (a handler that calls
 * back into player.apply) keeps the active state accurate via
 * enter/exit bracketing.
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
