---
title: Parsing Is Always Two Problems
date: 2026-02-08
tags: [parsing, design]
---

Every parser worth writing separates **lexical** structure from **syntactic** structure.

## The pattern

```ts
source ──► LEXER ──► tokens ──► PARSER ──► tree
```

The lexer answers "what are the atoms?" The parser answers "how do they nest?" Keeping them
apart is what makes both tractable.

## Why it matters concretely

In Markdown, the block phase decides which *lines* form a paragraph or a code fence. The
inline phase decides what the *characters* inside mean. Do both at once and you will parse
`*` inside a fenced code block as emphasis — the single most common bug in hand-rolled
Markdown converters.

In JSON, the number grammar is genuinely fiddly:

```
01      invalid — leading zero
.5      invalid — no integer part
5.      invalid — no fractional digits
```

All three are valid JavaScript. Isolating that in a lexer means the parser is 150 clean
lines that never look at a character.

## The exception that proves it

HTML breaks the rule, and it is instructive *why*: whether `<` starts a tag depends on which
element you are inside. `<script>if (a < b)</script>` has no tag in it. The tokenizer
therefore needs modes — which is to say the lexer needs a little syntactic context after all.

That is not a failure of the pattern. It is the reason the HTML spec defines a state machine
rather than a grammar.
