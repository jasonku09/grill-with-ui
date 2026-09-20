// End-to-end check of page.html against a real `serve`. Needs Playwright with Chromium:
//   PLAYWRIGHT_PKG=/path/to/node_modules/@playwright/test/index.mjs node test/page.e2e.mjs
// or, with @playwright/test installed next to this repo, just `node test/page.e2e.mjs`.
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const { chromium } = await import(process.env.PLAYWRIGHT_PKG || "@playwright/test");
const here = dirname(fileURLToPath(import.meta.url));
const SERVER = join(here, "..", "server.mjs");
const home = mkdtempSync(join(tmpdir(), "grill-e2e-home-"));
const env = { ...process.env, GRILL_HOME: home };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { session } = JSON.parse(execFileSync(process.execPath, [SERVER, "new", "--topic", "E2E topic", "--doc", "docs/e2e-design.md"], { encoding: "utf8", env, cwd: mkdtempSync(join(tmpdir(), "grill-e2e-proj-")) }));
const stateFile = join(session, "state.json");
const base = JSON.parse(readFileSync(stateFile, "utf8"));
const now = new Date().toISOString();
const fixture = () => ({
  ...base,
  agent: { status: "waiting", since: now, handled: 0 },
  terms: [{ term: "Send", def: "One press of Send to Agent.", avoid: ["submit", "reply"] }],
  questions: [
    { id: "q1", round: 1, deps: [], title: "Root question", body: "Answered earlier.", options: [{ k: "A", text: "First" }, { k: "B", text: "Second" }], rec: { option: "A", why: "Because." }, status: "answered", durable: true, updated: false, answer: { kind: "option", option: "B" }, thread: [{ who: "user", text: "Why not B?", at: now }, { who: "agent", text: "B is fine too.", at: now }] },
    { id: "q2", round: 2, deps: ["q1"], title: "Deferred one", body: "Parked.", options: [{ k: "A", text: "Yes" }], rec: { option: "A", why: "Sure." }, status: "deferred", durable: false, updated: false, thread: [] },
    { id: "q3", round: 3, deps: ["q1"], title: "Current open question", body: "Pick one.", options: [{ k: "A", text: "Alpha" }, { k: "B", text: "Beta" }, { k: "C", text: "Gamma" }], rec: { option: "B", why: "Beta balances both." }, status: "open", durable: false, updated: true, thread: [] },
    { id: "q4", round: 3, deps: ["q2"], title: "Free-text question", body: "No options here.", options: [], rec: { text: "Something short", why: "Keeps it simple." }, status: "open", durable: false, updated: false, thread: [] },
  ],
});
const writeState = (s) => writeFileSync(stateFile, JSON.stringify(s, null, 2));
writeState(fixture());

function startServe() {
  const child = spawn(process.execPath, [SERVER, "serve", "--session", session], { env, stdio: ["ignore", "pipe", "inherit"] });
  let buf = ""; const lines = []; const waiters = [];
  child.stdout.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { lines.push(buf.slice(0, i)); buf = buf.slice(i + 1); waiters.splice(0).forEach((w) => w()); } });
  const nth = (n) => new Promise((res) => { const c = () => (lines.length >= n ? res(lines[n - 1]) : waiters.push(c)); c(); });
  const stop = () => new Promise((res) => { if (child.exitCode !== null) return res(); child.on("exit", res); child.kill(); });
  return { child, lines, nth, stop };
}
let srv = startServe();
const ready = JSON.parse(await srv.nth(1));
const url = ready.url;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push(String(e)));
const results = [];
const check = (name, ok, extra = "") => { results.push({ name, ok, extra }); if (!ok) console.log("FAIL", name, extra); };

try {
  await page.goto(url);
  await page.locator(".item").first().waitFor();
  check("default selection = first open question in the current round", (await page.locator(".item.selected .id").textContent()) === "Q3");
  check("updated marker on q3", await page.locator(".item.updated .id", { hasText: "Q3" }).count() === 1);
  check("crumb shows recommendation updated", (await page.locator(".crumb .upd").textContent()) === "recommendation updated");
  check("send disabled with nothing staged", await page.locator("#send").isDisabled());
  check("no Accept button (clicking the recommended option is the accept)", await page.locator("#accept").count() === 0);
  check("explore button sits next to the title", await page.locator(".title-row #explore").count() === 1 && (await page.locator("#explore").textContent()) === "Explore deeper");
  check("system fonts only (no Google Fonts link)", (await page.content()).includes("fonts.googleapis") === false);
  const geo = await page.evaluate(() => { const r = (sel) => document.querySelector(sel).getBoundingClientRect(); return { main: r("main"), footer: r("footer"), h: innerHeight }; });
  check("layout fills the viewport (content row stretches, footer sits at the bottom)", Math.abs(geo.footer.bottom - geo.h) < 2 && Math.abs(geo.main.bottom - geo.footer.top) < 2 && geo.main.height > 600, JSON.stringify(geo));

  await page.locator("#terms-toggle").click();
  check("terms panel shows the term and its avoid list", (await page.locator("#terms").textContent()).includes("Avoid: submit, reply"));
  await page.locator("h1").click();

  await page.locator(".opt.rec").click();
  check("staging an option dims the rest of the card, the picked box stays full", await page.locator(".card.picked").count() === 1
    && (await page.locator(".opt.staged").evaluate((el) => getComputedStyle(el).opacity)) === "1"
    && Number(await page.locator(".opt:not(.staged)").first().evaluate((el) => getComputedStyle(el).opacity)) < 0.6
    && Number(await page.locator(".why").evaluate((el) => getComputedStyle(el).opacity)) < 0.6);
  await page.locator("#thread-in").fill("Would Alpha be simpler?");
  await page.locator("#stage-thread").click();
  check("staged count 2", (await page.locator("#send").textContent()) === "Send 2 to Agent");
  await page.locator("#explore").click();
  const exploreEv = JSON.parse(await srv.nth(2));
  check("explore sends immediately as its own event", exploreEv.seq === 1 && JSON.stringify(exploreEv.actions) === JSON.stringify([{ q: "q3", type: "explore" }]), JSON.stringify(exploreEv.actions));
  await page.waitForFunction(() => document.getElementById("explore").textContent.includes("Exploring…"));
  check("explore button shows exploring and is disabled; staging untouched", await page.locator("#explore").isDisabled() && (await page.locator("#send").textContent()) === "Send 2 to Agent");
  check("footer shows the explore send as sent", (await page.locator("#staged-list").textContent()).includes("Sent #1"));
  check("nav shows staged", (await page.locator(".item.selected .mark").textContent()) === "staged");
  await page.locator("#free").fill("draft text that should survive reload");
  await page.screenshot({ path: "/tmp/grill-v1.png" });

  await page.reload();
  await page.locator(".item").first().waitFor();
  check("staging survives reload (option, thread) and the exploring state too", (await page.locator("#send").textContent()) === "Send 2 to Agent" && (await page.locator("#explore").textContent()).includes("Exploring…") && await page.locator("#explore .spin").count() === 1);
  check("staged option still highlighted after reload", await page.locator(".opt.staged").count() === 1);
  check("staged thread message still shown after reload", await page.locator(".msg.staged").count() === 1);
  check("draft text survives reload", (await page.locator("#free").inputValue()) === "draft text that should survive reload");
  check("send stays disabled while a send is pending (nothing handled yet)", await page.locator("#send").isDisabled() && (await page.locator("#send").textContent()) === "Send 2 to Agent");
  let s0 = fixture(); s0.agent = { status: "waiting", since: new Date().toISOString(), handled: 1 };
  s0.questions[2].explore = { at: now, rows: [{ option: "A", pros: ["Fast"], cons: ["Rigid"] }, { option: "B", pros: ["Balanced", "Safe"], cons: ["Slower"] }, { option: "C", pros: ["Rich"], cons: ["Complex", "Costly"] }] };
  writeState(s0);
  await page.waitForFunction(() => document.getElementById("agent-status").textContent.includes("handled #1"));
  check("explore handled: button offers to explore again, send enabled again", (await page.locator("#explore").textContent()) === "Explore again" && await page.locator("#send").isEnabled());

  // deps link navigation + answered card + reopen
  await page.locator(".crumb a[data-go='q1']").click();
  check("deps link navigates to q1", (await page.locator(".item.selected .id").textContent()) === "Q1");
  check("chosen option is filled green with a circle check on the right, no Answered line", await page.locator(".opt.chosen").count() === 1 && (await page.locator(".opt.chosen .k").textContent()) === "B" && await page.locator(".opt.chosen .check svg circle").isVisible() && await page.locator(".opt.rec .check").isHidden() && await page.locator(".answered-line").count() === 0);
  check("chosen option background is the green fill", (await page.locator(".opt.chosen").evaluate((el) => getComputedStyle(el).backgroundColor)) === "rgb(227, 238, 229)");
  check("answered card dims everything but the chosen box", await page.locator(".card.picked").count() === 1 && Number(await page.locator(".opt.rec").evaluate((el) => getComputedStyle(el).opacity)) < 0.6 && (await page.locator(".opt.chosen").evaluate((el) => getComputedStyle(el).opacity)) === "1");
  check("sidebar shows a circle check for answered questions", await page.locator(".item", { hasText: "Q1" }).locator(".mark.answered svg circle").count() === 1 && await page.locator(".item", { hasText: "Q3" }).locator(".mark svg").count() === 0);
  check("q1 thread has 2 messages", await page.locator("aside .msg").count() === 2);
  await page.locator("#reopen").click();
  check("reopen staged on q1", (await page.locator(".staged-line").textContent()).includes("reopen"));
  await page.locator("#clear-staged").click();
  check("clear removes the staged reopen", await page.locator(".staged-line").count() === 0);

  // defer on q4 (free-text question, no options)
  await page.locator(".item", { hasText: "Q4" }).click();
  check("free-text question has no option list", await page.locator(".opt").count() === 0);
  check("free-text question shows suggested text", (await page.locator(".why").textContent()).includes("Suggested."));
  await page.locator("#defer").click();
  check("send label counts 3", (await page.locator("#send").textContent()) === "Send 3 to Agent");

  check("header has a Visualize button before any visual exists", await page.locator("header #visualize").count() === 1 && (await page.locator("#visualize").textContent()) === "Visualize" && await page.locator("body.visualize").count() === 0);

  // Discussion scroll. The panel is rebuilt on every render, so it used to snap back to the
  // top of a long thread on each send. q1 is answered with nothing staged on it, so its thread
  // can be watched across the send that ships q3's and q4's staging.
  s0.questions[0].thread = s0.questions[0].thread.concat(Array.from({ length: 22 }, (_, i) =>
    ({ who: i % 2 ? "agent" : "user", text: `Back and forth ${i + 1}. Long enough to take a couple of lines in the panel.`, at: now })));
  writeState(s0);
  await page.locator(".item", { hasText: "Q1" }).click();
  await page.waitForFunction(() => document.querySelectorAll("aside .msgs .msg").length === 24, null, { timeout: 5000 });
  const msgs = page.locator("aside .msgs");
  const scrollPos = () => msgs.evaluate((el) => ({ top: el.scrollTop, room: el.scrollHeight - el.clientHeight }));
  check("a long thread overflows the discussion panel", (await scrollPos()).room > 200);
  await msgs.evaluate((el) => (el.scrollTop = el.scrollHeight));
  const wasAtBottom = await scrollPos();

  await page.locator("#send").click();
  await page.waitForFunction(() => document.getElementById("staged-list").textContent.includes("Sent #2"));
  let pos = await scrollPos();
  check("a send keeps a thread that was at the bottom at the bottom", wasAtBottom.top > 200 && pos.room - pos.top <= 32, JSON.stringify(pos));
  await msgs.evaluate((el) => (el.scrollTop = 120));
  s0.questions[0].thread.push({ who: "agent", text: "One more reply while you were reading.", at: now });
  writeState(s0);
  await page.waitForFunction(() => document.querySelectorAll("aside .msgs .msg").length === 25, null, { timeout: 5000 });
  pos = await scrollPos();
  check("a reply landing mid-thread keeps the place you were reading", Math.abs(pos.top - 120) <= 2, JSON.stringify(pos));
  await page.locator(".item", { hasText: "Q3" }).click();
  await page.locator(".item", { hasText: "Q1" }).click();
  check("another question's thread starts at the top, not where the last one sat", (await scrollPos()).top === 0);
  await page.locator(".item", { hasText: "Q4" }).click();

  const ev = JSON.parse(await srv.nth(3));
  check("events.jsonl line has 3 actions", ev.seq === 2 && ev.actions.length === 3, JSON.stringify(ev.actions));
  const kinds = ev.actions.map((a) => `${a.q}:${a.type}${a.kind ? ":" + a.kind : ""}${a.option ? ":" + a.option : ""}`).sort();
  check("action shapes", JSON.stringify(kinds) === JSON.stringify(["q3:answer:accept:B", "q3:thread", "q4:defer"]), JSON.stringify(kinds));
  check("staging cleared after send", (await page.locator("#send").textContent()) === "Send to Agent");
  check("staged-list shows sent note", (await page.locator("#staged-list").textContent()).includes("Sent #2 · waiting for the agent"));
  check("file lines equal stdout lines", readFileSync(join(session, "events.jsonl"), "utf8").trim().split("\n").join("|") === [srv.lines[1], srv.lines[2]].join("|"));

  // pending indicators: the sent-but-unhandled work stays visible until the agent records it
  check("sidebar shows pending marks for the sent questions, not 'open'", await page.locator(".item", { hasText: "Q3" }).locator(".mark.pending .spin").count() === 1 && await page.locator(".item", { hasText: "Q4" }).locator(".mark.pending .spin").count() === 1 && await page.locator(".item", { hasText: "Q1" }).locator(".mark.pending").count() === 0);
  check("pending defer shown on the q4 card", (await page.locator(".pending-line").textContent()).includes("defer"));
  await page.locator(".item", { hasText: "Q3" }).click();
  check("pending answer shown on the sent option with a spinner", await page.locator(".opt.pending[data-opt='B'] .check .spin").count() === 1);
  check("pending thread message shown as sending", await page.locator("aside .msg.pending").count() === 1 && (await page.locator("aside .msg.pending .who").textContent()).includes("sending"));
  check("footer sent note carries a spinner", await page.locator("#staged-list .sent .spin").count() === 1);
  check("send disabled while pending even with new staging", (await (async () => { await page.locator(".opt[data-opt='A']").click(); return page.locator("#send").isDisabled(); })()));

  // agent working: disabled; after 5 min: enabled with a note
  let s = fixture(); s.agent = { status: "working", since: new Date().toISOString(), handled: 0 }; writeState(s);
  await page.waitForFunction(() => document.getElementById("agent-status").textContent.includes("Agent working"));
  await page.locator(".item", { hasText: "Q3" }).click();
  check("send disabled while working", await page.locator("#send").isDisabled());
  check("working indicator: header progress bar and status spinner", await page.locator("header.working #progress").isVisible() && await page.locator("#agent-status .spin").count() === 1);
  s = fixture(); s.agent = { status: "working", since: new Date(Date.now() - 6 * 60 * 1000).toISOString(), handled: 0 }; writeState(s);
  await page.waitForFunction(() => !document.getElementById("send").disabled);
  check("send re-enabled after 5 minutes of working with a note", (await page.locator("#send-why").textContent()).includes("may not be listening"));

  // handled catches up: sent note clears, selection jumps to the new round's open question
  s = fixture(); s.agent = { status: "waiting", since: new Date().toISOString(), handled: 2 };
  s.questions[2].status = "answered"; s.questions[2].answer = { kind: "accept", option: "B" };
  s.questions[2].explore = { at: now, rows: [{ option: "A", pros: ["Fast"], cons: ["Rigid"] }, { option: "B", pros: ["Balanced", "Safe"], cons: ["Slower"] }, { option: "C", pros: ["Rich"], cons: ["Complex", "Costly"] }] };
  s.questions[3].status = "answered"; s.questions[3].answer = { kind: "text", text: "Short and sweet" };
  s.questions.push({ id: "q5", round: 4, deps: ["q3"], title: "Next round question", body: "New.", options: [{ k: "A", text: "Go" }], rec: { option: "A", why: "Go." }, status: "open", durable: false, updated: false, thread: [] });
  s.note = "Round 4 is the last round I can see from here.";
  writeState(s);
  await page.waitForFunction(() => document.getElementById("agent-status").textContent.includes("handled #2"));
  check("sent note cleared when handled", !(await page.locator("#staged-list").textContent()).includes("Sent #"));
  check("agent note shown above the list", (await page.locator("nav .note").textContent()).includes("last round"));
  check("round 4 marked current", (await page.locator("nav .round.current").textContent()).includes("Round 4"));
  check("pending marks cleared once handled", await page.locator(".mark.pending").count() === 0 && await page.locator(".opt.pending").count() === 0 && await page.locator("header.working").count() === 0);
  check("finish does not flash while a question is open", await page.locator("#finish.ready").count() === 0);
  await page.locator(".item", { hasText: "Q3" }).click();
  check("pros/cons table renders in the discussion panel, one row per option", await page.locator("aside table.procon tbody tr").count() === 3 && (await page.locator("aside table.procon").textContent()).includes("Balanced") && (await page.locator("aside table.procon td.k.rec").textContent()) === "B");
  check("explore button offers to explore again once a table exists (exploring state cleared by handled)", (await page.locator("#explore").textContent()) === "Explore again" && await page.locator("#explore").isEnabled());
  check("Recommended tag turns green on the chosen box", (await page.locator(".opt.chosen.rec .tag").evaluate((el) => getComputedStyle(el).color)) === "rgb(61, 107, 74)");
  await page.locator(".item", { hasText: "Q4" }).click();
  check("free-text answer shows as a green chosen box with a check", await page.locator(".opt.chosen.text-answer").count() === 1 && (await page.locator(".opt.chosen.text-answer").textContent()).includes("Short and sweet") && await page.locator(".opt.chosen.text-answer .check").isVisible());

  // visualize: immediate event; the agent acknowledges at once and draws in the background, so grilling continues
  await page.locator("#visualize").click();
  const visEv = JSON.parse(await srv.nth(4));
  check("visualize sends immediately as its own event", visEv.seq === 3 && JSON.stringify(visEv.actions) === JSON.stringify([{ type: "visualize" }]), JSON.stringify(visEv.actions));
  await page.waitForFunction(() => document.getElementById("visualize").textContent.includes("Visualizing…"));
  check("visualize in flight: disabled with a spinner, still on the questions view", await page.locator("#visualize").isDisabled() && await page.locator("#visualize .spin").count() === 1 && await page.locator("body.visualize").count() === 0);
  // the agent acknowledges the send at once: handled = 3, a version-0 visual carrying `drawing`, no file yet
  s = fixture(); s.agent = { status: "waiting", since: new Date().toISOString(), handled: 3 };
  s.questions[2].status = "answered"; s.questions[2].answer = { kind: "accept", option: "B" };
  s.questions[3].status = "answered"; s.questions[3].answer = { kind: "text", text: "Short and sweet" };
  s.visual = { kind: "prototype", version: 0, thread: [], stale: false, drawing: { since: new Date().toISOString(), seq: 3 } };
  writeState(s);
  await page.waitForFunction(() => !document.getElementById("staged-list").textContent.includes("Sent #3"), null, { timeout: 5000 });
  check("first draw in the background: questions view stays, header keeps Visualizing…, no iframe request for v0", await page.locator("body.visualize").count() === 0 && await page.locator("#visualize").isDisabled() && (await page.locator("#visualize").textContent()).includes("Visualizing…") && !((await page.locator("#visual-frame").getAttribute("src")) || "").includes("v=0"));
  await page.locator(".item", { hasText: "Q3" }).click(); await page.locator("#clear-staged").click(); // drop the option staged on q3 while send #2 was pending
  await page.locator(".item", { hasText: "Q4" }).click();
  await page.locator("#thread-in").fill("Meanwhile, a question"); await page.locator("#stage-thread").click();
  check("send is enabled while the draw runs", await page.locator("#send").isEnabled() && (await page.locator("#send").textContent()) === "Send 1 to Agent");
  await page.locator("#send").click();
  const midEv = JSON.parse(await srv.nth(5));
  check("a send goes out during the draw", midEv.seq === 4 && midEv.actions.length === 1 && midEv.actions[0].type === "thread" && midEv.actions[0].text === "Meanwhile, a question", JSON.stringify(midEv.actions));
  await page.waitForFunction(() => document.getElementById("staged-list").textContent.includes("Sent #4"));
  check("visualize button stays Visualizing… while the mid-draw send is pending", await page.locator("#visualize").isDisabled() && (await page.locator("#visualize").textContent()).includes("Visualizing…"));
  // the agent handles the mid-draw send while the draw is still running
  s.agent = { status: "waiting", since: new Date().toISOString(), handled: 4 };
  s.questions[3].thread = [{ who: "user", text: "Meanwhile, a question", at: now }, { who: "agent", text: "Answered while drawing.", at: now }];
  writeState(s);
  await page.waitForFunction(() => !document.getElementById("staged-list").textContent.includes("Sent #4"), null, { timeout: 5000 });
  check("mid-draw send handled: reply shown, still drawing, still on the questions", (await page.locator("aside").textContent()).includes("Answered while drawing.") && await page.locator("aside .msg.pending").count() === 0 && await page.locator("body.visualize").count() === 0 && await page.locator("#visualize").isDisabled());
  // a first draw that runs over ten minutes releases the header button so the user can try again
  s.visual.drawing = { since: new Date(Date.now() - 11 * 60 * 1000).toISOString(), seq: 3 }; writeState(s);
  await page.waitForFunction(() => !document.getElementById("visualize").disabled, null, { timeout: 5000 });
  check("stuck first draw: Visualize re-enabled with a note", (await page.locator("#visualize").textContent()) === "Visualize" && ((await page.locator("#visualize").getAttribute("title")) || "").includes("over 10 minutes"));
  // the draw lands: version 1, the file, `drawing` gone → the view flips by itself
  writeFileSync(join(session, "visual.html"), "<!doctype html><title>proto</title><h1 id='proto-heading'>Prototype v1 heading</h1>");
  s.visual = { kind: "prototype", version: 1, at: new Date().toISOString(), note: "v1: first cut", thread: [], stale: false };
  writeState(s);
  await page.waitForFunction(() => document.body.classList.contains("visualize"), null, { timeout: 5000 });
  check("view flips to the visual by itself; list and card are hidden", await page.locator("nav").isHidden() && await page.locator("main").isHidden() && await page.locator("#visual-frame").isVisible());
  check("iframe src carries the version and the sandbox has no same-origin", (await page.locator("#visual-frame").getAttribute("src")).includes("v=1") && (await page.locator("#visual-frame").getAttribute("sandbox")) === "allow-scripts");
  check("strip shows the kind, version and note", (await page.locator("#visual-strip").textContent()).includes("Prototype") && (await page.locator("#visual-strip").textContent()).includes("v1: first cut"));
  check("iframe shows the agent's file", (await page.frameLocator("#visual-frame").locator("#proto-heading").textContent()) === "Prototype v1 heading");
  check("header button now toggles back to the questions", (await page.locator("#visualize").textContent()) === "Questions");
  check("right panel is the visual's feedback thread", (await page.locator("aside .head h3").textContent()).includes("Visual feedback") && await page.locator("#feedback-in").count() === 1);
  await page.locator("#feedback-in").fill("Make the list narrower");
  await page.locator("#stage-feedback").click();
  check("feedback staged: shown in the panel and in the footer", await page.locator("aside .msg.staged").count() === 1 && (await page.locator("#staged-list").textContent()).includes("visual +1 msg"));
  await page.reload();
  await page.waitForFunction(() => document.body.classList.contains("visualize"), null, { timeout: 5000 });
  check("visualize view and staged feedback survive reload", await page.locator("aside .msg.staged").count() === 1 && (await page.locator("#staged-list").textContent()).includes("visual +1 msg"));
  await page.locator("#send").click();
  await page.waitForFunction(() => document.getElementById("staged-list").textContent.includes("Sent #5"));
  const fbEv = JSON.parse(await srv.nth(6));
  check("send carries the visual feedback action", fbEv.seq === 5 && fbEv.actions.some((a) => a.type === "visual-feedback" && a.text === "Make the list narrower"), JSON.stringify(fbEv.actions));
  check("pending feedback shown as sending", await page.locator("aside .msg.pending").count() === 1);
  // the agent answers the feedback at once and redraws in the background: version still 1, `drawing` set
  const v1at = s.visual.at;
  s.agent = { status: "waiting", since: new Date().toISOString(), handled: 5 };
  s.visual = { kind: "prototype", version: 1, at: v1at, note: "v1: first cut", thread: [{ who: "user", text: "Make the list narrower", at: now }, { who: "agent", text: "Redrawing with a narrower list.", at: now }], stale: false, drawing: { since: new Date().toISOString(), seq: 5 } };
  writeState(s);
  await page.waitForFunction(() => document.querySelectorAll("aside .msg").length === 2 && !document.querySelector("aside .msg.pending"), null, { timeout: 5000 });
  check("redraw in the background: iframe kept at v1, strip says regenerating, no Regenerate link, header still toggles", (await page.locator("#visual-frame").getAttribute("src")).includes("v=1") && (await page.locator("#visual-strip").textContent()).includes("regenerating…") && await page.locator("#visual-strip .spin").count() === 1 && await page.locator("#regen").count() === 0 && (await page.locator("#visualize").textContent()) === "Questions" && await page.locator("#visualize").isEnabled());
  await page.locator("#feedback-in").fill("And bigger type"); await page.locator("#stage-feedback").click();
  check("feedback composer and Send work during the redraw", await page.locator("aside .msg.staged").count() === 1 && await page.locator("#send").isEnabled() && (await page.locator("#send").textContent()) === "Send 1 to Agent");
  await page.locator("aside .msg.staged [data-rmf]").click();
  check("staged feedback removed again", await page.locator("aside .msg.staged").count() === 0);
  // a redraw that runs over ten minutes brings Regenerate back with a note; the old version stays on screen
  s.visual.drawing = { since: new Date(Date.now() - 11 * 60 * 1000).toISOString(), seq: 5 }; writeState(s);
  await page.waitForFunction(() => !!document.getElementById("regen"), null, { timeout: 5000 });
  check("stuck redraw: Regenerate re-enabled with a note, iframe still v1", ((await page.locator("#regen").getAttribute("title")) || "").includes("over 10 minutes") && (await page.locator("#visual-frame").getAttribute("src")).includes("v=1") && await page.locator("#visual-strip .spin").count() === 0);
  // the redraw lands
  s.visual = { kind: "prototype", version: 2, at: new Date().toISOString(), note: "v2: narrower list", thread: s.visual.thread, stale: false };
  writeState(s);
  await page.waitForFunction(() => (document.getElementById("visual-frame").getAttribute("src") || "").includes("v=2"), null, { timeout: 5000 });
  check("iframe reloads on a version bump; the thread shows both messages; Regenerate is plain again", (await page.locator("#visual-strip").textContent()).includes("v2: narrower list") && await page.locator("aside .msg").count() === 2 && await page.locator("aside .msg.pending").count() === 0 && await page.locator("#regen").count() === 1 && !(await page.locator("#regen").getAttribute("title")));
  await page.locator("#visualize").click();
  check("toggling back restores the list and card", await page.locator("body.visualize").count() === 0 && await page.locator("nav .item").count() > 0 && await page.locator(".card").count() === 1 && (await page.locator("#visualize").textContent()).includes("Visual · v2"));

  // every question settled → Finish flashes; finish fires at once with whatever is staged
  await page.waitForFunction(() => document.getElementById("finish").classList.contains("ready"), null, { timeout: 5000 });
  check("finish flashes when nothing is open", await page.locator("#finish.ready").count() === 1);
  await page.locator(".item", { hasText: "Q3" }).click();
  await page.locator("#thread-in").fill("final note"); await page.locator("#stage-thread").click();
  await page.locator("#finish").click();
  check("inline confirm shown", await page.locator("#finish-yes").count() === 1);
  await page.locator("#finish-no").click();
  check("cancel keeps the finish button", await page.locator("#finish").count() === 1 && await page.locator("#finish-yes").count() === 0);
  await page.locator("#finish").click(); await page.locator("#finish-yes").click();
  const finEv = JSON.parse(await srv.nth(7));
  check("finish fires immediately, staged actions first, finish last", finEv.seq === 6 && finEv.actions.length === 2 && finEv.actions[0].type === "thread" && finEv.actions[0].text === "final note" && finEv.actions[1].type === "finish", JSON.stringify(finEv.actions));
  await page.waitForFunction(() => { const f = document.getElementById("finish"); return !!f && f.textContent.includes("Finishing…"); });
  check("finish button shows finishing; staging cleared", await page.locator("#finish").isDisabled() && await page.locator("#finish .spin").count() === 1 && (await page.locator("#send").textContent()) === "Send to Agent");

  // server gone → banner; restart on the same port → banner clears
  await srv.stop();
  await page.waitForFunction(() => document.getElementById("banner").classList.contains("show"), null, { timeout: 8000 });
  check("server-gone banner", (await page.locator("#banner").textContent()).includes("Server gone"));
  check("send disabled while gone", await page.locator("#send").isDisabled());
  srv = startServe();
  const ready2 = JSON.parse(await srv.nth(1));
  check("restart reuses the port", ready2.url === url, ready2.url);
  await page.waitForFunction(() => !document.getElementById("banner").classList.contains("show"), null, { timeout: 5000 });
  check("banner clears when the server is back", true);

  // finished state
  s = fixture(); s.agent = { status: "waiting", since: new Date().toISOString(), handled: 6 };
  s.visual = { kind: "prototype", version: 2, at: new Date().toISOString(), note: "v2: narrower list", thread: [] };
  s.finished = { doc: "docs/e2e-design.md", visual: "docs/e2e-visual.html", at: new Date().toISOString() }; writeState(s);
  await page.waitForFunction(() => document.getElementById("banner").classList.contains("done"));
  check("finished banner names the doc and the visual", (await page.locator("#banner").textContent()).includes("docs/e2e-design.md") && (await page.locator("#banner").textContent()).includes("docs/e2e-visual.html"));
  await page.locator("#visualize").click();
  check("finished: visual still viewable, composer and regenerate gone", await page.locator("body.visualize").count() === 1 && await page.locator("#feedback-in").count() === 0 && await page.locator("#regen").count() === 0);
  await page.locator("#visualize").click();
  check("staging locked when finished", await page.locator("#free").count() === 0 && await page.locator("#thread-in").count() === 0 && await page.locator("#finish").count() === 0);

  // The server-gone step above produces ERR_CONNECTION_REFUSED fetch failures by design.
  const real = errors.filter((e) => !e.includes("ERR_CONNECTION_REFUSED"));
  check("no console errors (besides the deliberate server-gone fetches)", real.length === 0, real.join(" | "));
} finally {
  await browser.close();
  await srv.stop();
}
const failed = results.filter((r) => !r.ok);
console.log(`page e2e: ${results.length - failed.length}/${results.length} checks passed${failed.length ? " — FAILED: " + failed.map((f) => f.name).join("; ") : ""}`);
process.exit(failed.length ? 1 : 0);
