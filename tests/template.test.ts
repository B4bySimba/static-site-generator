import assert from "node:assert/strict";
import { test } from "node:test";
import { TemplateEngine, TemplateError, escapeHtml } from "../src/index.js";

/** An engine backed by an in-memory template map. */
function engine(templates: Record<string, string> = {}): TemplateEngine {
  return new TemplateEngine({
    loader: (name) => {
      const source = templates[name];
      if (source === undefined) throw new Error(`Template not found: ${name}`);
      return source;
    },
  });
}

const render = (source: string, context: Record<string, unknown> = {}): string =>
  engine().renderString(source, context);

// --- Interpolation and escaping -------------------------------------------------

test("interpolates variables and dotted paths", () => {
  assert.equal(render("Hello {{ name }}!", { name: "world" }), "Hello world!");
  assert.equal(render("{{ a.b.c }}", { a: { b: { c: "deep" } } }), "deep");
  assert.equal(render("{{ missing }}", {}), "", "missing values render empty, not 'undefined'");
  assert.equal(render("{{ a.b.c }}", { a: {} }), "", "a missing path segment does not throw");
});

test("AUTO-ESCAPING is on by default", () => {
  // The single most important default in a template engine.
  const dangerous = '<script>alert("xss")</script>';
  const output = render("{{ value }}", { value: dangerous });
  assert.doesNotMatch(output, /<script>/);
  assert.match(output, /&lt;script&gt;/);
  assert.equal(render("{{ v }}", { v: `a"b'c&d<e>f` }), "a&quot;b&#39;c&amp;d&lt;e&gt;f");
});

test("| safe opts out of escaping, explicitly", () => {
  const html = "<em>trusted</em>";
  assert.equal(render("{{ value | safe }}", { value: html }), html);
  assert.equal(render("{{ value }}", { value: html }), "&lt;em&gt;trusted&lt;/em&gt;");
});

test("literals work as expressions", () => {
  assert.equal(render(`{{ "literal" }}`), "literal");
  assert.equal(render("{{ 42 }}"), "42");
  assert.equal(render("{{ true }}"), "true");
});

// --- Filters ---------------------------------------------------------------------

test("filters transform values and chain", () => {
  assert.equal(render("{{ v | upper }}", { v: "abc" }), "ABC");
  assert.equal(render("{{ v | lower }}", { v: "ABC" }), "abc");
  assert.equal(render("{{ v | capitalize }}", { v: "hello" }), "Hello");
  assert.equal(render("{{ v | trim | upper }}", { v: "  x  " }), "X", "chaining");
  assert.equal(render("{{ v | length }}", { v: [1, 2, 3] }), "3");
  assert.equal(render("{{ v | join }}", { v: ["a", "b"] }), "a, b");
  assert.equal(render(`{{ v | join:" / " }}`, { v: ["a", "b"] }), "a / b");
  assert.equal(render("{{ v | first }}", { v: [1, 2] }), "1");
  assert.equal(render("{{ v | reverse | join:'' }}", { v: ["a", "b"] }), "ba");
});

test("default and truncate", () => {
  assert.equal(render(`{{ v | default:"fallback" }}`, { v: "" }), "fallback");
  assert.equal(render(`{{ v | default:"fallback" }}`, {}), "fallback");
  assert.equal(render(`{{ v | default:"fallback" }}`, { v: "set" }), "set");
  assert.equal(render("{{ v | truncate:5 }}", { v: "abcdefghij" }), "abcde…");
  assert.equal(render("{{ v | truncate:50 }}", { v: "short" }), "short");
});

test("the date filter formats with token replacement", () => {
  const date = new Date("2026-03-15T14:30:45.000Z");
  assert.equal(render(`{{ d | date:"YYYY-MM-DD" }}`, { d: date }), "2026-03-15");
  assert.equal(render(`{{ d | date:"MMMM DD, YYYY" }}`, { d: date }), "March 15, 2026");
  assert.equal(render(`{{ d | date:"MMM DD" }}`, { d: date }), "Mar 15");
  assert.equal(render(`{{ d | date:"DDDD" }}`, { d: date }), "Sunday");
  assert.equal(render(`{{ d | date:"HH:mm:ss" }}`, { d: date }), "14:30:45");
  // Longest tokens must be replaced first, or YYYY gets eaten by YY.
  assert.equal(render(`{{ d | date:"YYYY" }}`, { d: date }), "2026");
  assert.equal(render(`{{ d | date:"YYYY-MM-DD" }}`, { d: "2026-03-15T00:00:00Z" }), "2026-03-15");
});

test("striptags, urlencode, json, sort, slice", () => {
  assert.equal(render("{{ v | striptags }}", { v: "<p>text</p>" }), "text");
  assert.equal(render("{{ v | urlencode }}", { v: "a b&c" }), "a%20b%26c");
  assert.equal(render("{{ v | json | safe }}", { v: { a: 1 } }), '{"a":1}');
  assert.equal(render("{{ v | sort | join }}", { v: ["c", "a", "b"] }), "a, b, c");
  assert.equal(render("{{ v | slice:0,2 | join }}", { v: [1, 2, 3] }), "1, 2");
});

test("an unknown filter is an error, not a silent no-op", () => {
  assert.throws(() => render("{{ v | nosuchfilter }}", { v: 1 }), TemplateError);
});

// --- Conditionals ------------------------------------------------------------------

test("if / elif / else", () => {
  const template = "{% if a %}A{% elif b %}B{% else %}C{% endif %}";
  assert.equal(render(template, { a: true }), "A");
  assert.equal(render(template, { a: false, b: true }), "B");
  assert.equal(render(template, { a: false, b: false }), "C");
});

test("truthiness treats empty arrays and strings as false", () => {
  assert.equal(render("{% if v %}yes{% else %}no{% endif %}", { v: [] }), "no");
  assert.equal(render("{% if v %}yes{% else %}no{% endif %}", { v: [1] }), "yes");
  assert.equal(render("{% if v %}yes{% else %}no{% endif %}", { v: "" }), "no");
  assert.equal(render("{% if v %}yes{% else %}no{% endif %}", { v: 0 }), "no");
  assert.equal(render("{% if v %}yes{% else %}no{% endif %}", {}), "no");
});

test("comparison operators", () => {
  assert.equal(render("{% if a == 1 %}y{% endif %}", { a: 1 }), "y");
  assert.equal(render("{% if a != 1 %}y{% endif %}", { a: 2 }), "y");
  assert.equal(render("{% if a > 5 %}y{% endif %}", { a: 10 }), "y");
  assert.equal(render("{% if a <= 5 %}y{% endif %}", { a: 5 }), "y");
  assert.equal(render(`{% if a == "x" %}y{% endif %}`, { a: "x" }), "y");
});

test("not negates", () => {
  assert.equal(render("{% if not a %}y{% endif %}", { a: false }), "y");
  assert.equal(render("{% if not a %}y{% endif %}", { a: true }), "");
});

test("conditionals NEST, which is why this is a tree and not a regex", () => {
  const template = "{% if a %}{% if b %}both{% else %}only-a{% endif %}{% else %}neither{% endif %}";
  assert.equal(render(template, { a: true, b: true }), "both");
  assert.equal(render(template, { a: true, b: false }), "only-a");
  assert.equal(render(template, { a: false, b: true }), "neither");
});

// --- Loops -----------------------------------------------------------------------------

test("for loops iterate arrays", () => {
  assert.equal(render("{% for x in items %}{{ x }},{% endfor %}", { items: [1, 2, 3] }), "1,2,3,");
  assert.equal(render("{% for x in items %}{{ x.name }}{% endfor %}", { items: [{ name: "a" }] }), "a");
});

test("the loop variable exposes index, first, last and length", () => {
  const template = "{% for x in items %}{{ loop.index }}:{{ x }}{% if loop.last %}!{% endif %} {% endfor %}";
  assert.equal(render(template, { items: ["a", "b"] }), "1:a 2:b! ");
  assert.equal(render("{% for x in i %}{{ loop.length }}{% endfor %}", { i: [1, 2] }), "22");
  assert.equal(render("{% for x in i %}{{ loop.first }}{% endfor %}", { i: [1, 2] }), "truefalse");
});

test("for/empty renders a fallback for empty collections", () => {
  const template = "{% for x in items %}{{ x }}{% empty %}nothing{% endfor %}";
  assert.equal(render(template, { items: [] }), "nothing");
  assert.equal(render(template, {}), "nothing");
  assert.equal(render(template, { items: ["a"] }), "a");
});

test("the two-name form binds index and item", () => {
  assert.equal(
    render("{% for i, x in items %}{{ i }}={{ x }} {% endfor %}", { items: ["a", "b"] }),
    "0=a 1=b ",
  );
});

test("loops NEST and the inner scope does not leak", () => {
  const template = "{% for row in rows %}{% for cell in row %}{{ cell }}{% endfor %}|{% endfor %}";
  assert.equal(render(template, { rows: [[1, 2], [3, 4]] }), "12|34|");

  // The loop variable must not persist after the loop.
  assert.equal(render("{% for x in i %}{{ x }}{% endfor %}[{{ x }}]", { i: [1] }), "1[]");
});

test("loops and conditionals compose", () => {
  const template = "{% for x in items %}{% if x > 2 %}{{ x }}{% endif %}{% endfor %}";
  assert.equal(render(template, { items: [1, 2, 3, 4] }), "34");
});

// --- Includes and inheritance -------------------------------------------------------------

test("include pulls in a partial with the current context", () => {
  const e = engine({ "partial.html": "[{{ value }}]" });
  assert.equal(e.renderString('{% include "partial.html" %}', { value: "x" }), "[x]");
});

test("extends replaces blocks in a layout", () => {
  const e = engine({
    "layout.html": "<html>{% block content %}default{% endblock %}</html>",
    "child.html": '{% extends "layout.html" %}{% block content %}overridden{% endblock %}',
  });
  assert.equal(e.render("child.html"), "<html>overridden</html>");
});

test("a block the child does not override keeps the parent's default", () => {
  const e = engine({
    "layout.html": "<h1>{% block title %}Default{% endblock %}</h1><p>{% block body %}Empty{% endblock %}</p>",
    "child.html": '{% extends "layout.html" %}{% block title %}Custom{% endblock %}',
  });
  assert.equal(e.render("child.html"), "<h1>Custom</h1><p>Empty</p>");
});

test("inheritance chains more than one level", () => {
  const e = engine({
    "base.html": "[{% block a %}a{% endblock %}{% block b %}b{% endblock %}]",
    "middle.html": '{% extends "base.html" %}{% block a %}A{% endblock %}',
    "leaf.html": '{% extends "middle.html" %}{% block b %}B{% endblock %}',
  });
  assert.equal(e.render("leaf.html"), "[AB]");
});

test("content outside a block is discarded when extending", () => {
  // This is what makes {% extends %} a layout rather than a concatenation.
  const e = engine({
    "layout.html": "<x>{% block c %}{% endblock %}</x>",
    "child.html": '{% extends "layout.html" %}stray text{% block c %}kept{% endblock %}',
  });
  assert.equal(e.render("child.html"), "<x>kept</x>");
});

test("a circular extends is detected rather than hanging", () => {
  const e = engine({
    "a.html": '{% extends "b.html" %}',
    "b.html": '{% extends "a.html" %}',
  });
  assert.throws(() => e.render("a.html"), /Circular/);
});

// --- Comments and errors --------------------------------------------------------------------

test("comments are stripped", () => {
  assert.equal(render("a{# hidden #}b"), "ab");
  assert.equal(render("{# {{ not.evaluated }} #}x"), "x");
});

test("malformed templates report the tag and line", () => {
  assert.throws(() => render("{{ unclosed"), /Unclosed/);
  assert.throws(() => render("{% nosuchtag %}"), /Unknown tag/);
  assert.throws(() => render("{% for %}x{% endfor %}"), /Malformed/);

  try {
    render("line1\nline2\n{% badtag %}");
    assert.fail("should have thrown");
  } catch (err) {
    assert.ok(err instanceof TemplateError);
    assert.equal(err.line, 3, "reports the right line");
  }
});

test("escapeHtml covers the five dangerous characters", () => {
  assert.equal(escapeHtml(`<>&"'`), "&lt;&gt;&amp;&quot;&#39;");
});

test("whitespace and literal text are preserved exactly", () => {
  assert.equal(render("  a  {{ v }}  b  ", { v: "x" }), "  a  x  b  ");
  assert.equal(render("no tags here"), "no tags here");
  assert.equal(render(""), "");
});
