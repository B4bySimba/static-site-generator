---
title: Determinism Is a Feature
date: 2026-07-19
tags: [build, design]
---

Two runs of the same build, on the same input, should produce byte-identical output. It
sounds obvious and almost nothing does it by default.

## Where non-determinism comes from

**Timestamps.** An RSS feed with `<lastBuildDate>${new Date()}</lastBuildDate>` differs on
every run. Inject the clock instead.

**Directory ordering.** `readdir` order is filesystem-dependent. Sort everything, explicitly.

**Map iteration.** Insertion-ordered, which means content-order-dependent. Sort keys before
emitting.

## What it buys

Content-hashed filenames only work if identical content yields an identical hash — which
requires identical bytes. `style.a3f9c1d2.css` can be cached forever precisely because a
change produces a different name.

Deploys become diffable. "Did anything actually change?" becomes answerable by comparing
hashes rather than re-reading the output.

## How to know you have it

Build twice into different directories and compare every file. That test lives in this
generator's suite, and it is three lines:

```ts
const first = await build({ ...options, outputDir: a, deterministic: true });
const second = await build({ ...options, outputDir: b, deterministic: true });
assert.deepEqual(await readAll(a), await readAll(b));
```

If you have not run that test, you do not have determinism. You have a build that happens to
agree with itself most of the time.
