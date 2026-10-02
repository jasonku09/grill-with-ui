// The renderer in page.html is an inline copy of markdown.mjs.
// This test pulls the inline copy out of page.html and runs the same
// cases against both, so the two cannot drift silently.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { md as libMd, esc } from "../markdown.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const pageHtml = fs.readFileSync(path.join(here, "..", "page.html"), "utf8");

function loadPageMd() {
  const begin = pageHtml.indexOf("// ---- markdown BEGIN ----");
  const end = pageHtml.indexOf("// ---- markdown END ----");
  assert.ok(begin !== -1 && end !== -1 && end > begin, "markdown markers missing in page.html");
  const snippet = pageHtml.slice(begin, end);
  const sandbox = { esc, console };
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

test("page.html links open in a new tab", () => {
  assert.match(
    pageMd("[docs](https://example.com)"),
    /target="_blank" rel="noopener noreferrer"/
  );
});
