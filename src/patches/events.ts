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
  }

  return detail;
}

export function installEventPatch(emit: Emit): () => void {
  const origAddEventListener = EventTarget.prototype.addEventListener;
  const origRemoveEventListener = EventTarget.prototype.removeEventListener;

  // Track wrapped handlers so removeEventListener works correctly
  const wrapperMap = new WeakMap<Function, Function>();

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
      // Only record events on DOM elements (not on window timers etc.)
      if (event.target instanceof Element) {
        emit({
          type: "event",
          eventType: event.type,
          targetPath: getTargetPath(event.target),
          timestamp: event.timeStamp,
          detail: extractDetail(event),
        });
      }
      return handler.call(this, event);
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

  return function uninstall() {
    EventTarget.prototype.addEventListener = origAddEventListener;
    EventTarget.prototype.removeEventListener = origRemoveEventListener;
  };
}
