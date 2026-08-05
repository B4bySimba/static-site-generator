---
title: The Tests That Earn Their Keep
date: 2026-03-22
tags: [testing, design]
---

Most tests confirm what you already believed. A few change what you believe. Those are the
ones worth designing for.

## Differential testing

If a correct implementation already exists, use it as an oracle. The JSON parser generates
thousands of random documents and asserts that its output is *identical* to `JSON.parse` —
in both directions:

- Both accept it, and the values match, **or**
- Both reject it.

Anything else is a bug. This found edge cases in surrogate-pair handling that no hand-written
case would have covered, because I did not know to write them.

## Conformance testing across implementations

The job queue has two backends — in-memory and Redis — behind one interface. One conformance
suite runs against **both**.

That suite caught a bug where Redis broke FIFO ordering for jobs enqueued in the same
millisecond: identical sorted-set scores fell back to lexicographic ordering by random UUID.
The in-memory backend passed. Only running the same test against both revealed it.

## Testing the second instance

The cron scheduler's DST handling was correct in `America/New_York` and wrong in
`Europe/London`. One zone has a negative UTC offset, the other zero — and my gap-resolution
logic silently depended on the sign.

One timezone in the test suite would have shipped that. Two caught it in a minute.

## The pattern

All three are the same idea: **arrange for something other than your own expectations to be
the judge.** An oracle, a second implementation, a second instance. Your expectations are
exactly as wrong as your code.
