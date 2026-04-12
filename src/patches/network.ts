/**
 * Network patch — intercepts fetch().
 *
 * Assigns monotonic sequence numbers to each request. Records the
 * response (status, content-type header, text body) when it resolves.
 * XMLHttpRequest interception deferred to a future patch.
 */

import type { NetworkOp } from "../ops.js";

export type Emit = (op: NetworkOp) => void;

export function installNetworkPatch(emit: Emit): () => void {
  const origFetch = globalThis.fetch;
  let nextSeq = 0;

  globalThis.fetch = async function (input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const seq = nextSeq++;
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? "GET";

    const response = await origFetch.call(globalThis, input, init);

    // Clone so we can read the body without consuming the original
    const clone = response.clone();
    let body: string | null = null;
    try {
      body = await clone.text();
    } catch {
      body = null;
    }

    emit({
      type: "network",
      kind: "fetch",
      seq,
      url,
      method,
      status: response.status,
      headers: { "content-type": response.headers.get("content-type") ?? "" },
      body,
    });

    return response;
  } as typeof globalThis.fetch;

  return function uninstall() {
    globalThis.fetch = origFetch;
  };
}
