---
title: Error Messages Are the Product
date: 2026-04-30
tags: [design, parsing]
---

`JSON.parse` is faster than anything you will write, correct, and shipped in every runtime.
So why write another one?

Because of this:

```
Unexpected token '}', ..."": [1, 2, },
  "pric"... is not valid JSON
```

versus this:

```
JsonParseError: Expected a value but found "}" (line 3, column 18)

  2 |   "name": "widget",
  3 |   "tags": [1, 2, },
    |                  ^
  4 |   "price": 9.99
```

## The cost of the second one

About **8x** the parse time. That is not a defect to be optimized away — it is the price of
being written in the language it parses, allocating a token object per token instead of
living inside V8's object representation.

## When each is right

Native, for hot paths on trusted input. Hand-written, for:

- Config files a human wrote and will have to fix
- Developer tooling, where the error IS the output
- Documents too large to hold in memory, where streaming matters more than speed

## The general lesson

"It already exists and is faster" answers a question about *throughput*. It does not answer
whether the existing thing does the job you have. Position tracking is not a feature you can
bolt onto a parser afterwards — it has to be threaded through the scanner from the start.
Decide early, or decide never.
