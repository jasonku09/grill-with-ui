// The renderer in page.html is an inline copy of markdown.mjs.
// This test pulls the inline copy out of page.html and runs the same
// cases against both, so the two cannot drift silently.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { md as libMd, esc as libEsc } from "../markdown.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const pageHtml = fs.readFileSync(path.join(here, "..", "page.html"), "utf8");

// The page's own escape function: md() builds on it, so the parity check
// must run against what the page actually ships, not a copy.
function loadPageEsc() {
  const line = pageHtml.match(/^const esc = .*$/m);
  assert.ok(line, "const esc missing in page.html");
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(`${line[0]}; globalThis.__esc = esc;`, sandbox);
  assert.equal(typeof sandbox.__esc, "function", "esc not defined in page.html");
  return sandbox.__esc;
}

const pageEsc = loadPageEsc();

function loadPageMd() {
  const begin = pageHtml.indexOf("// ---- markdown BEGIN ----");
  const end = pageHtml.indexOf("// ---- markdown END ----");
  assert.ok(begin !== -1 && end !== -1 && end > begin, "markdown markers missing in page.html");
  const snippet = pageHtml.slice(begin, end);
  const sandbox = { esc: pageEsc, console };
  vm.createContext(sandbox);
  vm.runInContext(`${snippet}; globalThis.__md = md;`, sandbox);
  assert.equal(typeof sandbox.__md, "function", "md not defined in page.html snippet");
  return sandbox.__md;
}

const pageMd = loadPageMd();

const cases = [
  "Use `code` here",
  "**bold**",
  "*italic*",
  "_italic_",
  "**bold `code`**",
  "my_variable_name",
  "a _real_ emphasis",
  "2 * 3 * 4 equals 24",
  "[docs](https://example.com)",
  "[x](javascript:alert(1))",
  "[x](ftp://example.com/x)",
  "[x](data:text/plain,hi)",
  "[x](data:text/html,hi)",
  "[x](//evil.com)",
  "[x](/visual)",
  "[x](#q3)",
  "[x](mailto:a@example.com)",
  "[docs](http://example.com)",
  "[docs](https://example.com/a?b=1)",
  "\0LINK7\0 and \0CODE3\0",
  "`[x](https://example.com)`",
  "[guide](https://example.com/_docs_/x)",
  "[**bold** guide](https://example.com)",
  "<b>hi</b> `a<b`",
];

test("page.html inline md matches markdown.mjs", () => {
  for (const input of cases) {
    assert.equal(pageMd(input), libMd(input), `drift on ${JSON.stringify(input)}`);
  }
});

test("page.html esc matches markdown.mjs esc", () => {
  for (const input of [`<a href="x" title='y'>&amp;</a>`, "", null, undefined, 42]) {
    assert.equal(pageEsc(input), libEsc(input), `esc drift on ${JSON.stringify(input)}`);
  }
});

test("page.html renders only absolute http and https links", () => {
  for (const input of ["[x](//evil.com)", "[x](/visual)", "[x](javascript:alert(1))", "[x](data:text/html,hi)", "[x](mailto:a@example.com)"]) {
    assert.equal(pageMd(input), input, `link rendered for ${JSON.stringify(input)}`);
  }
  assert.equal(
    pageMd("[docs](https://example.com)"),
    '<a href="https://example.com" target="_blank" rel="noopener noreferrer">docs</a>'
  );
});

test("page.html links open in a new tab", () => {
  assert.match(
    pageMd("[docs](https://example.com)"),
    /target="_blank" rel="noopener noreferrer"/
  );
});
