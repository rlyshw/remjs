/**
 * Internal symbols shared across the remjs runtime.
 *
 * Split into their own module to avoid a circular import between
 * proxy.ts, codec.ts, and registry.ts — each needs to refer to these
 * symbols but they all import from each other in various combinations.
 *
 * - `RAW` pulls the raw target out of a remjs proxy.
 * - `ID` is the registry-assigned object id, stored as a non-enumerable
 *   property on tracked objects so reads are O(1) and the id survives
 *   garbage collection of the registry's WeakMap entry. The WeakMap is
 *   still the source of truth for frozen objects (which can't be tagged).
 */
export const RAW = Symbol.for("remjs.raw");
export const ID = Symbol.for("remjs.id");
