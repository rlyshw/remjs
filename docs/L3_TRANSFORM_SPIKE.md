# L3 transform — contract sketch (spike)

> **Status: spike (exploratory).** This document mocks out what
> `@remjs/transform` would do without implementing it. The goal is to
> validate that the transform can produce code that targets remjs's
> existing v0.2 API, with no protocol or core changes. If the contract
> here holds, L3 is engineering work; if it doesn't, we have to revisit.

## Goal

Take arbitrary JavaScript source code and rewrite it so that every
binding write — including closure-local `let`/`const`, primitive
locals, and object property mutations — flows through `remjs`'s op
stream **without modifying the source-author's code or the remjs
core**.

The transform is the L3 capture mechanism. It composes with `@remjs/
shell` (in-browser runtime) and `@remjs/proxy` (the server-side fetch
proxy) or with `@remjs/extension` (the alternative deployment as a
Manifest V3 browser extension).

## The core trick: scope hoisting

remjs's `Proxy` adapter can capture mutations to **object properties**
but not to **closure-local bindings** (because closures aren't
accessible from outside the function). The transform's job is to
**rewrite local bindings as properties of a synthetic scope object**
that IS accessible to the proxy.

```js
// before transform — closure local, invisible to remjs
function makeCounter() {
  let count = 0;
  return () => count++;
}

// after transform — property of a tracked scope object
function makeCounter() {
  const __scope = __remjs.track({ count: 0 });
  return () => __scope.count++;
}
```

That's it. The transform's job is mechanically rewriting `count` →
`__scope.count` everywhere it appears in the function body.
**`__remjs.track` is the existing `createObserver().track()` from
v0.2.** No new API, no new op type, no protocol additions. The
existing op stream captures the mutation as a normal `set` op
addressed by ref.

## API contract: what the transform expects from remjs

The transform produces code that calls into a global `__remjs` object.
The runtime (which `@remjs/shell` provides) sets that global up:

```ts
// what @remjs/shell installs as window.__remjs

interface RemjsRuntime {
  /** v0.2 — wraps obj in a Proxy and tracks it via the observer.
   *  Returns the wrapped reference; the transform binds this to the
   *  scope variable. */
  track<T extends object>(obj: T): T;

  /** v0.2 — return the current observer's snapshot. */
  snapshot(): SnapshotOp;

  /** v0.2 — force-flush pending ops. */
  flush(): void;

  /** Optional convenience the transform may emit at the head of every
   *  function: tag the scope with a hint about which function it
   *  belongs to. Pure metadata for debugging. */
  scope(name: string, scope: object): object;
}
```

Critically: **everything in this interface already exists in v0.2.**
`scope()` is a thin wrapper around `track()` that also tags the scope
object for the inspector to label correctly. We can ship `scope()` as
a one-line helper without any other change to remjs core.

## The shell

`@remjs/shell` is a tiny page that bootstraps the runtime:

```js
// @remjs/shell — what it does at the top of the bundled page
import { createObserver } from "remjs";

const observer = createObserver({
  onOps: (ops) => transport.send(ops),
  batchMode: "microtask",
});

window.__remjs = {
  track: (obj) => observer.track(obj),
  scope: (name, obj) => {
    Object.defineProperty(obj, "__remjs_scope_name", { value: name, enumerable: false });
    return observer.track(obj);
  },
  snapshot: () => observer.snapshot(),
  flush: () => observer.flush(),
};

// Transport setup, optional API shims, etc.
```

That's the entire shell runtime. ~15 lines of meaningful code. The
transform's output depends only on this global being available before
the transformed code runs.

## Worked examples

### 1. Local variable mutation

```js
// IN
let x = 0;
x = 1;
x++;

// OUT
const __scope = __remjs.scope("module", { x: 0 });
__scope.x = 1;
__scope.x++;
```

The transform hoists `let x` into a property of a synthetic `__scope`
object that's tracked at module load time. Subsequent reads/writes
become member access expressions.

### 2. Object property write

```js
// IN
const obj = { count: 0 };
obj.count++;

// OUT
const __scope = __remjs.scope("module", { obj: { count: 0 } });
__scope.obj.count++;  // already works via the existing Proxy adapter
```

When the value being assigned is itself an object, the existing v0.2
proxy lazily wraps it on first read. The transform doesn't need to do
anything special — the Proxy chain handles nested objects already.

### 3. Function-local closure

```js
// IN
function makeCounter() {
  let count = 0;
  return () => ++count;
}
const c = makeCounter();
c();
c();

// OUT
function makeCounter() {
  const __scope_makeCounter = __remjs.scope("makeCounter", { count: 0 });
  return () => ++__scope_makeCounter.count;
}
const __scope = __remjs.scope("module", { c: makeCounter() });
__scope.c();
__scope.c();
```

The closure works naturally: the returned arrow function captures
`__scope_makeCounter` by reference, which is the proxied scope object.
Calls to `c()` mutate `count` via the proxy, emitting ops.

### 4. Multiple closures over the same scope

```js
// IN
function makeAdder() {
  let sum = 0;
  return {
    add(n) { sum += n; },
    get() { return sum; },
  };
}

// OUT
function makeAdder() {
  const __scope = __remjs.scope("makeAdder", { sum: 0 });
  return {
    add(n) { __scope.sum += n; },
    get() { return __scope.sum; },
  };
}
```

Both `add` and `get` close over the same `__scope`. Mutations from
either method are captured by the same proxy.

### 5. Nested scopes

```js
// IN
function outer() {
  let a = 1;
  function inner() {
    let b = 2;
    a += b;
  }
  return inner;
}

// OUT
function outer() {
  const __scope_outer = __remjs.scope("outer", { a: 1 });
  function inner() {
    const __scope_inner = __remjs.scope("inner", { b: 2 });
    __scope_outer.a += __scope_inner.b;
  }
  return inner;
}
```

Each function gets its own scope object. References to outer
variables resolve to the lexically-enclosing scope object — the
transform tracks which scope owns which name and rewrites accordingly.

### 6. Destructuring

```js
// IN
let { x, y } = { x: 1, y: 2 };
x += y;

// OUT
const __scope = __remjs.scope("module", { x: 1, y: 2 });
// (the original literal is folded into __scope's initializer)
__scope.x += __scope.y;
```

For destructured locals the transform inlines the rhs values directly
into the scope object's initializer. For complex destructuring
patterns (rest, defaults, nested) the transform may emit a temporary
binding and then assign individual fields.

### 7. Module-level `import`

```js
// IN
import { createStore } from "zustand";
const useStore = createStore((set) => ({ count: 0, inc: () => set((s) => ({ count: s.count + 1 })) }));

// OUT
import { createStore } from "zustand";
const __scope = __remjs.scope("module", {
  useStore: createStore((set) => ({ count: 0, inc: () => set((s) => ({ count: s.count + 1 })) })),
});
```

`import`s are NOT rewritten — they bind module exports which the
transform doesn't own. Top-level `let`/`const` declarations after the
imports get hoisted. The transform must run on every module the page
loads (the proxy/extension intercepts each one).

## What the transform does NOT do

- **Rewrite imports.** Module exports are owned by the source module;
  the transform leaves them alone. State that lives only inside an
  unmodified third-party module (e.g. React's internal fiber) is
  invisible. To capture that state we'd need either source-level
  hooks (L1) or to also transform `node_modules` (which the
  proxy/extension can do — just slower).
- **Rewrite primitive operators.** `x + y` stays `x + y` even if `x`
  resolves to `__scope.x`. Only assignments and increments go through
  the scope.
- **Touch function calls.** Function calls remain unmodified. The
  transform is about *binding writes*, not about every expression.
- **Capture `this`.** `this` is a contextual binding that JavaScript
  rebinds on each call. The transform leaves it alone; if you want to
  track properties of `this`, the proxy adapter does that already
  via the parent object.
- **Handle eval().** Code that constructs JS strings and `eval`s them
  bypasses the transform. We can either ban it or transform the input
  string at runtime via the same Babel pipeline. The latter is doable
  but slow.

## Edge cases and known unknowns

| Case | Plan | Confidence |
| --- | --- | --- |
| `let`/`const` at any scope | scope hoisting | ✓ high |
| `var` | hoist to function-scope object | ✓ high |
| top-level module `let`/`const` | module-scope object | ✓ high |
| destructuring | inline into scope initializer | ✓ medium |
| object/array spread | works (just literal values) | ✓ high |
| function declarations | hoist function value into scope | ✓ medium |
| arrow functions | natural — they close over the scope object | ✓ high |
| `class` declarations | declare class normally; instances get tracked when assigned to a scope prop | ⚠ medium |
| class fields | declared as instance properties; the proxy adapter catches writes | ⚠ medium |
| `try`/`catch` | catch binding is its own scope | ⚠ medium |
| `for`/`while`/`for-of` | `let` in for-init is loop-scoped; one scope object per loop iteration | ⚠ low — perf concern |
| `async`/`await` | works because the function body is just rewritten before being made async | ✓ medium |
| generators | similar — body rewrite, generator wrapping unchanged | ⚠ medium |
| dynamic `import()` | transformed at fetch time by the proxy | ⚠ medium |
| `eval()` | as above, transformed string at runtime; slow | ⚠ low |
| `Function` constructor | same as eval — runtime transform | ⚠ low |
| `with()` blocks | the transform refuses to touch them; `with` is deprecated anyway | ✓ |
| `super` references | leave alone | ✓ |
| TDZ (temporal dead zone) | assigning to an uninitialized scope prop is a no-op error; need to preserve TDZ semantics | ⚠ medium |
| Hoisted function declarations | hoist into scope before use sites | ⚠ medium |

The "low confidence" rows are the ones a spike would actually need to
prove out. The "high confidence" rows are well-understood — they're
the same problems any source-level instrumentation tool solves.

## Performance budget

Each binding access goes through a Proxy `get` or `set` trap. On V8,
that's roughly 50-150ns per access. For most app code that's
imperceptible. For tight loops (image processing, physics, parsers),
it's a 5-10x slowdown.

For the rembrowser use case (live mirror of arbitrary apps), the
overhead is acceptable. For production use, the user should be able
to mark hot regions as "do not transform" via a comment directive
(`/* @remjs-skip */`) which the transform respects.

## Composition with `@remjs/shell` and the deployment layer

```
┌──────────────────────────────────────────────────────────────┐
│  user opens remjs.app/?https://app.com                        │
└──────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────┐
│  shell.html (served from remjs.app)                           │
│    ▸ loads @remjs/shell runtime which sets up window.__remjs  │
│    ▸ fetches app.com's HTML via @remjs/proxy                  │
│    ▸ for each <script>: fetches via proxy, runs through       │
│      @remjs/transform, eval()s the result                     │
│    ▸ also runs the page's HTML                                │
└──────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────┐
│  page now runs in user's browser, with every binding write    │
│  flowing through __remjs → observer → onOps → transport       │
└──────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────┐
│  ops stream over WebSocket / postMessage / direct callback    │
│  to a viewer that uses createReceiver().apply(ops) — the      │
│  same v0.2 receiver, no changes                               │
└──────────────────────────────────────────────────────────────┘
```

Alternative deployment as a browser extension:

```
┌──────────────────────────────────────────────────────────────┐
│  user installs @remjs/extension                               │
│  user navigates to https://app.com normally                   │
└──────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────┐
│  extension webRequest.onBeforeRequest fires for each .js     │
│    ▸ fetches the script                                       │
│    ▸ runs through @remjs/transform                            │
│    ▸ returns transformed source to the page                   │
└──────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────┐
│  page runs at https://app.com normally (real cookies, real    │
│  origin, real auth) but every binding write flows through     │
│  __remjs which the extension's content script set up          │
└──────────────────────────────────────────────────────────────┘
```

Both deployments share the **same transform** and the **same shell
runtime**. They differ only in *where the transform runs* (server
side proxy vs in-browser extension) and *which origin the page runs
in* (proxy.origin vs real origin).

## Open questions for the spike

The spike's goal is to answer these. Each is a yes/no that decides
whether L3 is feasible without major rework.

1. **Does the scope-hoisting trick actually work for real React
   code?** Pick a small React component (`useState` + `useEffect` +
   a callback), transform it by hand, see if it runs.
2. **What's the perf impact on a typical app's render loop?** Time
   a transformed React TodoMVC against the unmodified version.
   Acceptable: <10x slowdown. Ideal: <2x.
3. **Can a Babel plugin actually do scope hoisting cleanly?**
   Babel has good scope-tracking primitives (`path.scope`,
   `bindings`, `kind`); a plugin should be able to walk every
   `Identifier` reference and rewrite based on its binding's
   scope. Verify on a few non-trivial files.
4. **What does the perf look like for the proxy fetch + transform
   roundtrip on a real app's first load?** Babel-standalone is
   ~3MB and slow. esbuild-wasm is ~150KB but limited. Decide
   whether the spike uses Babel or esbuild.
5. **Do API shims (`window`, `document`, `fetch`, `localStorage`)
   work for a small app, or do they immediately blow up?** Build a
   minimal shim and try it on TodoMVC.

If 1+3 are yes, L3-as-shim is feasible. If 2 is acceptable, it's
practical. If 4+5 are not blockers, ship it.

## Spike output: what success looks like

The spike is done when one of these is true:

- ✓ A small React app (TodoMVC or similar) runs in the shell, ops
  flow into the viewer, the viewer reconstructs the state. **L3 is
  feasible — start engineering @remjs/transform for real.**
- ✗ The transform produces broken code on common JS constructs
  (specific failure modes documented). **L3 is not feasible without
  redesign — pivot to L1 framework hooks or to JSDOM.**
- ✗ The transform works but the perf is 100x slower or the shims are
  insurmountable. **L3 might be feasible eventually but not as a
  spare-time project — defer indefinitely.**

Either way the spike answers the question. The doc is the contract;
the working/broken code is the answer.

## What this DOESN'T commit to

This spike doc deliberately leaves these open:

- **Whether the transform is Babel or SWC or esbuild or hand-written.**
  Implementation detail; doesn't affect the contract.
- **Whether the deployment is proxy or extension.** Both are
  architecturally valid; pick based on user needs.
- **Whether `@remjs/transform` ships as one package or splits into
  `core` + `babel-plugin` + `swc-plugin`.** Packaging concern;
  decide later.
- **Whether the shell ships shimmed APIs or runs the page in a real
  iframe with same-origin escapes.** Tactics, not strategy.

## Next steps from here

1. **Hand-transform a small React file by hand** to validate that
   the scope-hoisting output (a) parses, (b) runs correctly, (c)
   produces the expected ops via remjs core. ~half day.
2. **If hand transform works**, write a 100-line Babel plugin that
   does the same automatically. Run it on a few test files.
3. **If the plugin works**, integrate with `@remjs/shell` (a stub
   that just sets up the runtime) and run a test page through it.
4. **If the page runs and emits ops**, declare the spike a success
   and start the real implementation.

If at any step the answer is "no", document why and pivot.
