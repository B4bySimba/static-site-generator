---
title: Why Build It From Scratch
date: 2026-01-15
tags: [meta, learning]
---

There is a specific kind of understanding you only get by writing the thing yourself.

## The library-shaped hole

When you `npm install` a Markdown parser, you get a working parser and a hole in your
understanding shaped exactly like that parser. You know its API. You do not know why
`snake_case_variable` is not italicised, or why `*` and `_` follow different rules.

Both facts fall out of one design decision - the CommonMark delimiter-run flanking rules -
and you will never encounter that decision by reading an API reference.

## What "from scratch" should mean

It does not mean avoiding all dependencies. It means not importing **the thing you are
trying to understand**:

- Building a job queue? A Redis client is fine. `bullmq` is not.
- Building a WebSocket server? `net` is fine. `ws` is not.
- Building a parser? Nothing.

> The test is simple: if the dependency would make the interesting part disappear, it is
> the wrong dependency.

## The measurable payoff

Every one of these projects surfaced a bug that only exists because the code was written
rather than imported:

| Project | Bug found |
|:--------|:----------|
| Cron scheduler | DST gap resolution correct in New York, wrong in London |
| Job queue | Redis FIFO broken for same-millisecond enqueues |
| Markdown parser | Delimiter placeholders merged into adjacent text |

None of these would have been found by reading. All of them were found by testing something
I had written.
