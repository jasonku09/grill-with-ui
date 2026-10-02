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

test("links render as anchors, unsafe URLs stay literal", () => {
  assert.equal(
    md("[docs](https://example.com)"),
    '<a href="https://example.com">docs</a>'
  );
  assert.equal(
    md("[x](javascript:alert(1))"),
    "[x](javascript:alert(1))"
  );
  assert.equal(
    md("`[x](https://example.com)`"),
    '<code>[x](https://example.com)</code>'
  );
});
