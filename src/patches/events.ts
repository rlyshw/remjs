/**
 * Event patch — intercepts addEventListener to record DOM events.
 *
 * When a registered event handler fires, records an EventOp with
 * the target's CSS selector path and event-specific details.
 */

import type { EventOp } from "../ops.js";
import { getTargetPath } from "../target.js";

export type Emit = (op: EventOp) => void;

/** Extract serializable details from a DOM event. */
function extractDetail(event: Event): Record<string, unknown> {
  const detail: Record<string, unknown> = {};

  if (typeof PointerEvent !== "undefined" && event instanceof PointerEvent) {
    detail.clientX = event.clientX;
    detail.clientY = event.clientY;
    detail.button = event.button;
    detail.buttons = event.buttons;
    detail.pointerId = event.pointerId;
  } else if (event instanceof MouseEvent) {
    detail.clientX = event.clientX;
    detail.clientY = event.clientY;
    detail.button = event.button;
    detail.buttons = event.buttons;
  }

  if (event instanceof KeyboardEvent) {
    detail.key = event.key;
    detail.code = event.code;
    detail.altKey = event.altKey;
    detail.ctrlKey = event.ctrlKey;
    detail.shiftKey = event.shiftKey;
    detail.metaKey = event.metaKey;
  }

  if (event instanceof InputEvent) {
    detail.data = event.data;
    detail.inputType = event.inputType;
  }

  // Capture input/textarea/select value for input/change events
  if (
    (event.type === "input" || event.type === "change") &&
    event.target &&
    "value" in (event.target as HTMLElement)
  ) {
    detail.value = (event.target as HTMLInputElement).value;
  }

  if (event.type === "scroll" && event.target) {
    const el = event.target as Element;
    detail.scrollTop = el.scrollTop;
    detail.scrollLeft = el.scrollLeft;
    // Percentage form so replays on different viewport sizes land at the
    // same logical position (e.g. "50% down") instead of being clamped.
    const maxTop = el.scrollHeight - el.clientHeight;
    const maxLeft = el.scrollWidth - el.clientWidth;
    detail.scrollTopPct = maxTop > 0 ? el.scrollTop / maxTop : 0;
    detail.scrollLeftPct = maxLeft > 0 ? el.scrollLeft / maxLeft : 0;
  }

  return detail;
}

/**
 * Collect on-event property names from a prototype (e.g. "onclick").
 * Walks the prototype chain since most live on GlobalEventHandlers.prototype.
 */
function collectOnProps(proto: object): string[] {
  const names = new Set<string>();
  let cur: object | null = proto;
  while (cur && cur !== Object.prototype) {
    for (const name of Object.getOwnPropertyNames(cur)) {
      if (name.startsWith("on") && name.length > 2) {
        const desc = Object.getOwnPropertyDescriptor(cur, name);
        if (desc && (desc.set || desc.get)) names.add(name);
      }
    }
    cur = Object.getPrototypeOf(cur);
  }
  return [...names];
}

/**
 * Shim IDL on-event handlers (el.onclick = fn) so they route through
 * addEventListener — which our patched version records.
 *
 * Without this, el.onclick = fn installs a handler via the single-slot
 * IDL path that bypasses addEventListener entirely, so the recorder
 * never sees the events it fires.
 */
export function installIdlHandlerShim(): () => void {
  const stored = Symbol("remjs_idl_handler");
  const targets: Array<{ proto: object; names: string[]; origDescs: Map<string, { proto: object; desc: PropertyDescriptor }> }> = [];

  const protos: object[] = [];
  if (typeof HTMLElement !== "undefined") protos.push(HTMLElement.prototype);
  if (typeof Document !== "undefined") protos.push(Document.prototype);
  if (typeof Window !== "undefined") protos.push(Window.prototype);

  for (const proto of protos) {
    const names = collectOnProps(proto);
    const origDescs = new Map<string, { proto: object; desc: PropertyDescriptor }>();

    for (const name of names) {
      // Find the prototype that actually owns the descriptor.
      let owner: object | null = proto;
      let desc: PropertyDescriptor | undefined;
      while (owner) {
        desc = Object.getOwnPropertyDescriptor(owner, name);
        if (desc) break;
        owner = Object.getPrototypeOf(owner);
      }
      if (!desc || !owner) continue;
      origDescs.set(name, { proto: owner, desc });

      const eventType = name.slice(2);
      Object.defineProperty(proto, name, {
        configurable: true,
        enumerable: true,
        get(this: EventTarget & Record<symbol, Record<string, EventListener | null>>) {
          const bag = this[stored];
          return (bag && bag[name]) ?? null;
        },
        set(this: EventTarget & Record<symbol, Record<string, EventListener | null>>, fn: EventListener | null) {
          let bag = this[stored];
          if (!bag) {
            bag = {};
            Object.defineProperty(this, stored, { value: bag, configurable: true, enumerable: false, writable: true });
          }
          const prev = bag[name];
          if (prev) this.removeEventListener(eventType, prev);
          const next = typeof fn === "function" ? fn : null;
          bag[name] = next;
          if (next) this.addEventListener(eventType, next);
        },
      });
    }

    targets.push({ proto, names, origDescs });
  }

  return function uninstallIdl() {
    for (const { proto, names, origDescs } of targets) {
      for (const name of names) {
        const orig = origDescs.get(name);
        if (!orig) {
          delete (proto as Record<string, unknown>)[name];
          continue;
        }
        if (orig.proto === proto) {
          Object.defineProperty(proto, name, orig.desc);
        } else {
          // Descriptor was inherited — remove our override so inheritance resumes.
          delete (proto as Record<string, unknown>)[name];
        }
      }
    }
  };
}

export function installEventPatch(emit: Emit): () => void {
  const origAddEventListener = EventTarget.prototype.addEventListener;
  const origRemoveEventListener = EventTarget.prototype.removeEventListener;

  // Track wrapped handlers so removeEventListener works correctly
  const wrapperMap = new WeakMap<Function, Function>();

  // Dispatch depth: when a handler synchronously triggers a cascading
  // event (e.g. label click → synthesized input click → change), the
  // browser invokes listeners for those derived events while we are
  // still inside the outer handler. Those should NOT be recorded — the
  // follower's browser will cascade naturally when the outer event
  // replays. Depth > 0 means we're inside a user-supplied handler.
  let dispatchDepth = 0;
  // Dedup: a single Event object can hit multiple listeners (capture,
  // target, bubble). Emit it at most once per original dispatch.
  const seenEvents = new WeakSet<Event>();

  EventTarget.prototype.addEventListener = function (
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions,
  ) {
    if (!listener) {
      return origAddEventListener.call(this, type, listener, options);
    }

    const handler = typeof listener === "function" ? listener : listener.handleEvent.bind(listener);
    const self = this;

    const wrapper = function (this: EventTarget, event: Event) {
      if (
        dispatchDepth === 0 &&
        event.target instanceof Element &&
        !seenEvents.has(event)
      ) {
        seenEvents.add(event);
        emit({
          type: "event",
          eventType: event.type,
          targetPath: getTargetPath(event.target),
          timestamp: event.timeStamp,
          detail: extractDetail(event),
        });
      }
      dispatchDepth++;
      try {
        return handler.call(this, event);
      } finally {
        dispatchDepth--;
      }
    };

    wrapperMap.set(handler, wrapper);
    return origAddEventListener.call(self, type, wrapper as EventListener, options);
  };

  EventTarget.prototype.removeEventListener = function (
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | EventListenerOptions,
  ) {
    if (!listener) {
      return origRemoveEventListener.call(this, type, listener, options);
    }
    const handler = typeof listener === "function" ? listener : listener.handleEvent.bind(listener);
    const wrapper = wrapperMap.get(handler);
    if (wrapper) {
      wrapperMap.delete(handler);
      return origRemoveEventListener.call(this, type, wrapper as EventListener, options);
    }
    return origRemoveEventListener.call(this, type, listener, options);
  };

  const uninstallIdl = installIdlHandlerShim();

  return function uninstall() {
    uninstallIdl();
    EventTarget.prototype.addEventListener = origAddEventListener;
    EventTarget.prototype.removeEventListener = origRemoveEventListener;
  };
}
