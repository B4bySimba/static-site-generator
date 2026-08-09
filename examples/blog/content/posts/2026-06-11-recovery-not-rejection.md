---
title: Recovery, Not Rejection
date: 2026-06-11
tags: [parsing, html]
---

Most parsers are written to reject bad input. HTML parsers are written to *never* reject
anything, and that inversion changes the whole design.

## Every byte sequence is a document

```html
<p>a<b>bold</p>after
</div><p>x</p>
<div><p><span>text
<<<>>>
```

A browser renders all four. The spec does not describe a grammar and then handle errors - it
describes an algorithm whose *definition* covers every input.

## The rules that do the work

**Implied end tags.** `<p>` cannot contain `<p>`, so a second one closes the first:

```
<p>a<p>b  ──►  <p>a</p><p>b</p>
```

**Foster parenting.** Text is not allowed directly inside `<table>`. Rather than dropping it,
the spec *moves it out*, before the table:

```
<table>stray<tr><td>x</td></tr></table>
  ──►
stray<table><tr><td>x</td></tr></table>
```

It looks absurd until you realize it is why two decades of broken table markup still renders.

## Why this matters for security

An HTML sanitizer built on regexes fails because the attacker and the browser agree on how to
parse the input, and the regex does not:

- `<img/src=x/onerror=alert(1)>` - slashes are valid separators
- `<a href="jav&#97;script:...">` - entity-encoded scheme
- `<scr<script>ipt>` - the filter's own removal creates the tag

Sanitize the parsed **tree** and all of them close at once, because the ambiguity is already
resolved. Error recovery is not a nicety here; it is the security boundary.
