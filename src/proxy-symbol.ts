/**
 * Internal symbol to pull the raw target out of a remjs proxy.
 *
 * Split into its own module to avoid a circular import between proxy.ts
 * and codec.ts — codec needs to unwrap proxies while encoding, and
 * proxy.ts needs to call encode while emitting ops.
 */
export const RAW = Symbol.for("remjs.raw");
