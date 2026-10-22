import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const page = readFileSync(new URL("../page.html", import.meta.url), "utf8");
const unread = page.slice(page.indexOf("let seenFor ="), page.indexOf("// ---- rendering ----"));
const aside = page.slice(page.indexOf("function renderAside()"), page.indexOf("function renderFeedback("));
function setup(seen = 0, at) {
  const q = { id: "q1", thread: [] };
  const elements = [];
  const box = { getBoundingClientRect: () => ({ top: 0, bottom: 100 }) };
  const panel = {
    querySelector: () => box,
    querySelectorAll: () => elements,
  };
  const context = vm.createContext({
    local: { seen: { q1: seen } }, storeKey: "grill:test", selected: "q1",
    qs: () => [q], byId: () => q, save() {},
    activeView: () => context.view, view: "questions",
    $: () => panel, innerHeight: 100,
    document: { visibilityState: "visible", querySelector: () => ({ getBoundingClientRect: () => ({ top: 100 }) }) },
    renderFeedback() {},
  });
  vm.runInContext(unread + aside, context);
  const run = (code) => vm.runInContext(code, context);
  const replace = (texts) => {
    q.thread = texts.map((text) => ({ who: "agent", text, ...(at === undefined ? {} : { at }) }));
    elements.splice(0, elements.length, ...texts.map(() => ({
      new: false,
      getBoundingClientRect: () => ({ top: 200, bottom: 240, height: 40 }),
      classList: { toggle(name, value) { this.owner[name] = value; } },
    })));
    for (const el of elements) el.classList.owner = el;
    run("syncSeen()");
  };
  const show = (index) => {
    elements.forEach((el, i) => { el.getBoundingClientRect = () => ({ top: i === index ? 0 : 200, bottom: i === index ? 40 : 240, height: 40 }); });
    run("noteSeen()");
  };
  return { context, elements, replace, run, show };
}

for (const seen of [0, 1]) {
  for (const at of [undefined, "2026-10-19T00:00:00Z"]) {
    test(`rewriting clears out-of-order sightings and pill baseline (seen=${seen}, at=${at})`, () => {
      const h = setup(seen, at);
      h.replace(["old first", "old second", "old third"]);
      h.run("tagNew(byId(selected))");
      h.show(2);
      assert.equal(h.context.local.seen.q1, seen);
      h.replace([]);
      h.replace(["replacement first", "replacement second", "replacement third"]);
      h.run("tagNew(byId(selected))");
      assert.equal(h.elements[0].new, true);
      h.show(0);
      h.show(1);
      assert.equal(h.context.local.seen.q1, 2);
      h.show(2);
      assert.equal(h.context.local.seen.q1, 3);
    });
  }
}

test("ordinary appends preserve out-of-order sightings", () => {
  const h = setup();
  h.replace(["first", "second", "third"]);
  h.show(2);
  h.replace(["first", "second", "third", "fourth"]);
  h.show(0);
  assert.equal(h.context.local.seen.q1, 1);
  h.show(1);
  assert.equal(h.context.local.seen.q1, 3);
});

test("leaving Questions resets pills while preserving unseen replies", () => {
  const h = setup();
  h.replace(["first", "second"]);
  h.run("tagNew(byId(selected))");
  h.show(0);
  h.run("tagNew(byId(selected))");
  assert.deepEqual(h.elements.map((el) => el.new), [true, true]);
  h.context.view = "visualize";
  h.run("renderAside()");
  h.context.view = "questions";
  h.run("tagNew(byId(selected))");
  assert.deepEqual(h.elements.map((el) => el.new), [false, true]);
});
