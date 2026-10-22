// Unit tests for markdown.mjs (issue #9: Support markdown).
// Seam: pure md(text) -> safe HTML. No DOM, no server.
import { test } from "node:test";
import assert from "node:assert/strict";
import { md } from "../markdown.mjs";

test("backticks render as code and HTML is escaped", () => {
  assert.equal(md("Use `code` here"), "Use <code>code</code> here");
  assert.equal(
    md("<b>hi</b> `a<b`"),
    "&lt;b&gt;hi&lt;/b&gt; <code>a&lt;b</code>"
  );
});

test("asterisks and underscores render bold and italic", () => {
  assert.equal(md("**bold**"), "<strong>bold</strong>");
  assert.equal(md("*italic*"), "<em>italic</em>");
  assert.equal(md("_italic_"), "<em>italic</em>");
  assert.equal(md("**bold `code`**"), "<strong>bold <code>code</code></strong>");
  assert.equal(md("my_variable_name"), "my_variable_name");
  assert.equal(md("a _real_ emphasis"), "a <em>real</em> emphasis");
});

test("emphasis needs non-whitespace at the edges", () => {
  assert.equal(md("2 * 3 * 4 equals 24"), "2 * 3 * 4 equals 24");
  assert.equal(md("** bold**"), "** bold**");
  assert.equal(md("**bold **"), "**bold **");
  assert.equal(md("* italic*"), "* italic*");
  assert.equal(md("*italic *"), "*italic *");
  assert.equal(md("a *real* emphasis"), "a <em>real</em> emphasis");
});

test("links render as anchors, unsafe URLs stay literal", () => {
  assert.equal(
    md("[docs](https://example.com)"),
    '<a href="https://example.com" target="_blank" rel="noopener noreferrer">docs</a>'
  );
  assert.equal(
    md("[x](javascript:alert(1))"),
    "[x](javascript:alert(1))"
  );
  assert.equal(
    md("[x](ftp://example.com/x)"),
    "[x](ftp://example.com/x)"
  );
  assert.equal(
    md("[x](data:text/plain,hi)"),
    "[x](data:text/plain,hi)"
  );
  assert.equal(
    md("`[x](https://example.com)`"),
    '<code>[x](https://example.com)</code>'
  );
});

test("only absolute http and https links render; everything else stays plain text", () => {
  assert.equal(
    md("[docs](https://example.com/a?b=1)"),
    '<a href="https://example.com/a?b=1" target="_blank" rel="noopener noreferrer">docs</a>'
  );
  assert.equal(
    md("[docs](http://example.com)"),
    '<a href="http://example.com" target="_blank" rel="noopener noreferrer">docs</a>'
  );
  // Protocol-relative: would load another origin.
  assert.equal(md("[x](//evil.com)"), "[x](//evil.com)");
  // Relative path: /visual would open the agent's visual unsandboxed.
  assert.equal(md("[x](/visual)"), "[x](/visual)");
  assert.equal(md("[x](#q3)"), "[x](#q3)");
  assert.equal(md("[x](javascript:alert(1))"), "[x](javascript:alert(1))");
  assert.equal(md("[x](data:text/html,hi)"), "[x](data:text/html,hi)");
  assert.equal(md("[x](mailto:a@example.com)"), "[x](mailto:a@example.com)");
});

test("placeholder-shaped input stays literal", () => {
  assert.equal(md("\0LINK7\0 and \0CODE3\0"), "\0LINK7\0 and \0CODE3\0");
});

test("formatting never rewrites link URLs", () => {
  assert.equal(
    md("[guide](https://example.com/_docs_/x)"),
    '<a href="https://example.com/_docs_/x" target="_blank" rel="noopener noreferrer">guide</a>'
  );
  assert.equal(
    md("[**bold** guide](https://example.com)"),
    '<a href="https://example.com" target="_blank" rel="noopener noreferrer"><strong>bold</strong> guide</a>'
  );
});

test("links open in a new tab", () => {
  assert.match(
    md("[docs](https://example.com)"),
    /target="_blank" rel="noopener noreferrer"/
  );
});
