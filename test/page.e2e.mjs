// End-to-end check of page.html against a real `serve`. Needs Playwright with Chromium:
//   PLAYWRIGHT_PKG=/path/to/node_modules/@playwright/test/index.mjs node test/page.e2e.mjs
// or, with @playwright/test installed next to this repo, just `node test/page.e2e.mjs`.
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
const evidence = process.env.GRILL_EVIDENCE_DIR;
if (evidence) mkdirSync(evidence, { recursive: true });
const capture = async (name) => { if (evidence) await page.screenshot({ path: join(evidence, name), fullPage: true }); };
// WCAG contrast of two colours as the page resolves them under a theme (light-dark() included).
// fg and bg are [selector, computed-style property]. One synchronous evaluate: nothing repaints.
const contrast = (theme, fg, bg) => page.evaluate(([theme, fg, bg]) => {
  const root = document.documentElement, was = root.dataset.theme; root.dataset.theme = theme;
  const lum = ([sel, prop]) => {
    const x = document.createElement("canvas").getContext("2d"); x.fillStyle = getComputedStyle(document.querySelector(sel))[prop]; x.fillRect(0, 0, 1, 1);
    const [r, g, b] = [...x.getImageData(0, 0, 1, 1).data].slice(0, 3).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const a = lum(fg), b = lum(bg); root.dataset.theme = was;
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}, [theme, fg, bg]);
const readable = async (fg, bg, min) => { const r = [await contrast("light", fg, bg), await contrast("dark", fg, bg)]; return { ok: r.every((x) => x >= min), extra: `light ${r[0].toFixed(2)}:1, dark ${r[1].toFixed(2)}:1, need ${min}:1` }; };

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
  check("no intent line when the session has none", await page.locator("#intent.show").count() === 0);
  check("tab title is topic-only without intent", (await page.title()) === "grill · E2E topic");
  const withIntent = fixture(); withIntent.intent = "Decide how sessions remember a user across tabs"; writeState(withIntent);
  await page.waitForFunction(() => document.getElementById("intent").classList.contains("show"));
  check("intent line shows under the topic", (await page.locator("#intent.show").textContent()) === "Decide how sessions remember a user across tabs");
  check("tab title carries the intent", (await page.title()) === "grill · E2E topic — Decide how sessions remember a user across tabs");
  writeState(fixture());
  await page.waitForFunction(() => !document.getElementById("intent").classList.contains("show"));
  check("clearing intent hides the line again", await page.locator("#intent.show").count() === 0);
  const long = fixture();
  long.intent = "Decide whether guests check out without an account. If not, settle where the account gets created. Returns and support need an account either way, so the follow-up settles ownership and the retry path stays idempotent across both flows.";
  writeState(long);
  await page.waitForFunction(() => document.getElementById("intent").classList.contains("clamped"));
  check("long intent clamps to one line with a pointer", await page.locator("#intent.show.clamped").count() === 1);
  await page.locator("#intent.show").click();
  await page.waitForFunction(() => document.getElementById("intent").classList.contains("open"));
  check("click expands the full intent", (await page.locator("#intent.show.open").textContent()) === long.intent);
  await page.locator("#intent.show").click();
  await page.waitForFunction(() => !document.getElementById("intent").classList.contains("open"));
  check("click collapses back to one line", await page.locator("#intent.show.clamped").count() === 1);
  writeState(fixture());
  await page.waitForFunction(() => !document.getElementById("intent").classList.contains("show"));

  await page.locator("#terms-toggle").click();
  check("terms panel shows the term and its avoid list", (await page.locator("#terms").textContent()).includes("Avoid: submit, reply"));
  await page.locator("h1").click();

  // theme: the toggle cycles system → light → dark. System follows the OS, the other two
  // override it, and the server keeps the choice so a reload (or the next grill) starts with it.
  const mode = () => page.locator("#theme-toggle").getAttribute("data-mode");
  const isDark = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor.match(/\d+/g).slice(0, 3).reduce((n, v) => n + Number(v), 0) < 384);
  const cycle = async () => { const r = page.waitForResponse((x) => x.url().endsWith("/theme") && x.request().method() === "POST"); await page.locator("#theme-toggle").click(); return (await r).status(); };
  await page.emulateMedia({ colorScheme: "dark" });
  check("theme: system follows a dark OS", (await mode()) === "system" && await isDark());
  await page.emulateMedia({ colorScheme: "light" });
  check("theme: system follows a light OS", !(await isDark()));
  await page.emulateMedia({ colorScheme: "dark" });
  check("theme: first click forces light over a dark OS", (await cycle()) === 200 && (await mode()) === "light" && !(await isDark()));
  await page.emulateMedia({ colorScheme: "light" });
  check("theme: second click forces dark over a light OS", (await cycle()) === 200 && (await mode()) === "dark" && await isDark());
  await page.reload();
  await page.locator(".item").first().waitFor();
  check("theme: the choice survives a reload, set before the script runs", (await mode()) === "dark" && await isDark() && (await (await fetch(url)).text()).includes('<html lang="en" data-theme="dark">'));
  await capture("theme-dark.png");
  check("theme: third click returns to system", (await cycle()) === 200 && (await mode()) === "system" && !(await isDark()));
  await page.locator(".item", { hasText: "Q1" }).click();
  let cr = await readable([".opt.chosen .check path", "stroke"], [".opt.chosen .check circle", "fill"], 3);
  check("theme: the tick on a chosen option stands out from its circle in both themes", cr.ok, cr.extra);
  await page.locator(".item", { hasText: "Q3" }).click();

  await page.locator(".opt.rec").click();
  check("staging an option dims the rest of the card, the picked box stays full", await page.locator(".card.picked").count() === 1
    && (await page.locator(".opt.staged").evaluate((el) => getComputedStyle(el).opacity)) === "1"
    && Number(await page.locator(".opt:not(.staged)").first().evaluate((el) => getComputedStyle(el).opacity)) < 0.6
    && Number(await page.locator(".why").evaluate((el) => getComputedStyle(el).opacity)) < 0.6);
  await page.locator("#thread-in").fill("Would Alpha be simpler?");
  await page.locator("#stage-thread").click();
  check("staged count 2", (await page.locator("#send").textContent()) === "Send 2 to Agent");
  cr = await readable(["#send", "color"], ["#send", "backgroundColor"], 4.5);
  check("theme: Send to Agent is readable in both themes", await page.locator("#send").isEnabled() && cr.ok, cr.extra);
  // ⌘↩ in a compose box stages the draft; a second ⌘↩ sends it (issue #12)
  await page.locator(".item", { hasText: "Q4" }).click();
  await page.locator("#free").fill("Short and sweet");
  await page.locator("#free").press("Meta+Enter");
  check("cmd+enter stages free text", (await page.locator(".staged-line").textContent()).includes("Short and sweet") && (await page.locator("#send").textContent()) === "Send 3 to Agent");
  await page.locator("#clear-staged").click();
  check("clear removes the staged text", await page.locator(".staged-line").count() === 0 && (await page.locator("#send").textContent()) === "Send 2 to Agent");
  await page.locator(".item", { hasText: "Q3" }).click();
  await page.locator("#thread-in").fill("Keyboard staged thread");
  await page.locator("#thread-in").press("Meta+Enter");
  check("cmd+enter stages a discussion message", await page.locator("aside .msg.staged").count() === 2 && (await page.locator("#send").textContent()) === "Send 3 to Agent");
  await page.locator("aside .msg.staged [data-rm]").last().click();
  check("staged thread removed again", await page.locator("aside .msg.staged").count() === 1 && (await page.locator("#send").textContent()) === "Send 2 to Agent");
  await page.locator("#explore").click();
  const exploreEv = JSON.parse(await srv.nth(2));
  check("explore sends immediately as its own event", exploreEv.seq === 1 && JSON.stringify(exploreEv.actions) === JSON.stringify([{ q: "q3", type: "explore" }]), JSON.stringify(exploreEv.actions));
  await page.waitForFunction(() => document.getElementById("explore").textContent.includes("Exploring…"));
  check("explore button shows exploring and is disabled; staging untouched", await page.locator("#explore").isDisabled() && (await page.locator("#send").textContent()) === "Send 2 to Agent");
  check("footer shows the explore send as sent", (await page.locator("#staged-list").textContent()).includes("Sent #1"));
  check("nav shows staged", (await page.locator(".item.selected .mark").textContent()) === "staged");
  await page.locator("#free").fill("draft text that should survive reload");
  await capture("grill-staged.png");

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
  check("header has a Use subagent checkbox beside Visualize, checked by default", await page.locator("header #use-subagent").isVisible() && await page.locator("#use-subagent").isChecked() && (await page.locator("label[for=use-subagent]").textContent()).trim() === "Use subagent");
  check("the info bubble explains the trade-off", (await page.locator("#subagent-info").getAttribute("data-tip")) === "Using subagents frees up your main context for grilling. You can switch this off once you are done grilling to make the visualization build faster." && (await page.locator("#subagent-info").getAttribute("aria-label")) === "Using subagents frees up your main context for grilling. You can switch this off once you are done grilling to make the visualization build faster.");
  await page.locator("#subagent-info").focus();
  await capture("subagent-default-tooltip.png");
  await page.locator("#subagent-info").blur();

  // Discussion scroll, first on a panel that cannot scroll at all: nothing there is "at the
  // bottom", so long content arriving is read from its first line. The pros and cons table is
  // the sharp case, because it renders above the thread rather than after it.
  await page.locator(".item", { hasText: "Q1" }).click();
  const msgs = page.locator("aside .msgs");
  const scrollPos = () => msgs.evaluate((el) => ({ top: el.scrollTop, room: el.scrollHeight - el.clientHeight }));
  const beforeTable = await scrollPos();
  s0.questions[0].explore = { at: now, rows: Array.from({ length: 8 }, (_, i) => ({
    option: String.fromCharCode(65 + i),
    pros: [1, 2, 3].map((k) => `Pro ${k} for option ${i + 1}, long enough to wrap in the panel.`),
    cons: [1, 2, 3].map((k) => `Con ${k} for option ${i + 1}, long enough to wrap in the panel.`),
  })) };
  writeState(s0);
  await page.waitForFunction(() => document.querySelectorAll("aside .msgs table.procon tbody tr").length === 8, null, { timeout: 5000 });
  const tablePos = await scrollPos();
  const headInView = await msgs.evaluate((el) => {
    const h = el.querySelector(".explore-head"); if (!h) return false;
    const box = el.getBoundingClientRect(), head = h.getBoundingClientRect();
    return head.top >= box.top - 1 && head.bottom <= box.bottom + 1;
  });
  check("an explore table landing in a short thread stays in view, not scrolled off the top",
    beforeTable.room === 0 && tablePos.room > 200 && tablePos.top === 0 && headInView,
    JSON.stringify({ beforeTable, tablePos, headInView }));

  await page.locator(".item", { hasText: "Q4" }).click();
  const beforeReply = await scrollPos();
  s0.questions[3].thread = [{ who: "agent", text: Array.from({ length: 40 }, (_, i) => `Line ${i + 1} of a reply taller than the panel it lands in.`).join("\n"), at: now }];
  writeState(s0);
  await page.waitForFunction(() => document.querySelectorAll("aside .msgs .msg").length === 1, null, { timeout: 5000 });
  const replyPos = await scrollPos();
  check("a long reply landing in a short thread leaves the panel at its first line",
    beforeReply.room === 0 && replyPos.room > 200 && replyPos.top === 0,
    JSON.stringify({ beforeReply, replyPos }));

  // Then on one that does scroll: the panel is rebuilt on every render, so it used to snap back
  // to the top of a long thread on each send. q1 is answered with nothing staged on it, so its
  // thread can be watched across the send that ships q3's and q4's staging.
  s0.questions[0].thread = s0.questions[0].thread.concat(Array.from({ length: 22 }, (_, i) =>
    ({ who: i % 2 ? "agent" : "user", text: `Back and forth ${i + 1}. Long enough to take a couple of lines in the panel.`, at: now })));
  writeState(s0);
  await page.locator(".item", { hasText: "Q1" }).click();
  await page.waitForFunction(() => document.querySelectorAll("aside .msgs .msg").length === 24, null, { timeout: 5000 });
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
  check("visualize sends immediately as its own event", visEv.seq === 3 && JSON.stringify(visEv.actions) === JSON.stringify([{ type: "visualize", subagent: true }]), JSON.stringify(visEv.actions));
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
  check("Use subagent stays in the header while a visual is shown", await page.locator("#use-subagent").isVisible());
  await page.locator("#use-subagent").uncheck();
  await page.reload();
  await page.waitForFunction(() => document.body.classList.contains("visualize"), null, { timeout: 5000 });
  check("visualize view and staged feedback survive reload", await page.locator("aside .msg.staged").count() === 1 && (await page.locator("#staged-list").textContent()).includes("visual +1 msg"));
  check("Use subagent stays unchecked across a reload", !(await page.locator("#use-subagent").isChecked()));
  await capture("subagent-unchecked-after-reload.png");
  await page.locator("#send").click();
  await page.waitForFunction(() => document.getElementById("staged-list").textContent.includes("Sent #5"));
  const fbEv = JSON.parse(await srv.nth(6));
  check("send carries the visual feedback action", fbEv.seq === 5 && fbEv.actions.some((a) => a.type === "visual-feedback" && a.text === "Make the list narrower" && a.subagent === false), JSON.stringify(fbEv.actions));
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
  check("confirm keeps the green but stops blinking", await page.locator("#finish-yes.ready").count() === 1
    && (await page.locator("#finish-yes").evaluate((el) => getComputedStyle(el).animationName)) === "none");
  cr = await readable(["#finish-yes", "color"], ["#finish-yes", "backgroundColor"], 4.5);
  check("theme: the green confirm is readable in both themes", cr.ok, cr.extra);
  await page.locator("#finish-no").click();
  check("cancel keeps the finish button", await page.locator("#finish").count() === 1 && await page.locator("#finish-yes").count() === 0);
  await page.locator("#finish").click(); await page.locator("#finish-yes").click();
  const finEv = JSON.parse(await srv.nth(7));
  check("finish fires immediately, staged actions first, finish last", finEv.seq === 6 && finEv.actions.length === 2 && finEv.actions[0].type === "thread" && finEv.actions[0].text === "final note" && finEv.actions[1].type === "finish" && finEv.actions[1].subagent === false, JSON.stringify(finEv.actions));
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
  check("finished: Use subagent is hidden, nothing left to draw", await page.locator("#use-subagent").isHidden());
  await capture("subagent-hidden-finished.png");
  if (evidence) writeFileSync(join(evidence, "page-events.jsonl"), readFileSync(join(session, "events.jsonl")));
  await page.locator("#visualize").click();
  check("staging locked when finished", await page.locator("#free").count() === 0 && await page.locator("#thread-in").count() === 0 && await page.locator("#finish").count() === 0);

  // multi question: options toggle into a set, the recommendation is a set, the send carries options
  s = fixture(); s.agent = { status: "waiting", since: new Date().toISOString(), handled: 6 };
  s.questions.push({ id: "q5", round: 4, deps: [], title: "Which channels?", body: "Any mix.", multi: true,
    options: [{ k: "A", text: "Email" }, { k: "B", text: "SMS" }, { k: "C", text: "Push" }],
    rec: { options: ["A", "C"], why: "Both are free to send." }, status: "open", durable: false, updated: false, thread: [] });
  s.questions.push({ id: "q6", round: 4, deps: [], title: "Answered multi", body: "Done.", multi: true,
    options: [{ k: "A", text: "One" }, { k: "B", text: "Two" }, { k: "C", text: "Three" }],
    rec: { options: ["A"], why: "Fine." }, status: "answered", answer: { kind: "option", options: ["A", "B"] }, durable: false, updated: false, thread: [] });
  writeState(s);
  await page.waitForFunction(() => !document.getElementById("banner").classList.contains("done"));
  await page.locator(".item", { hasText: "Q5" }).click();
  check("multi: hint shown, both recommended options marked, why names the set", await page.locator(".multi-hint").count() === 1 && await page.locator(".opt.rec").count() === 2 && (await page.locator(".why b").textContent()) === "Why A + C.");
  await page.locator('.opt[data-opt="A"]').click();
  await page.locator('.opt[data-opt="B"]').click();
  check("multi: two clicks stage two options", await page.locator(".opt.staged").count() === 2 && (await page.locator(".staged-line").textContent()).includes("Staged: options A + B") && (await page.locator("#staged-list").textContent()).includes("Q5 → A + B"));
  await page.locator('.opt[data-opt="B"]').click();
  await page.locator('.opt[data-opt="C"]').click();
  check("multi: toggling to the recommended set stages an accept", (await page.locator(".staged-line").textContent()).includes("Staged: accept A + C"));
  await page.locator('.opt[data-opt="A"]').click(); await page.locator('.opt[data-opt="C"]').click();
  check("multi: an emptied set unstages the answer", await page.locator(".staged-line").count() === 0 && await page.locator(".item .mark.staged").count() === 0);
  await page.locator("#accept-rec").click();
  check("multi: accept link stages the recommended set", (await page.locator(".staged-line").textContent()).includes("Staged: accept A + C"));
  await page.locator(".item", { hasText: "Q6" }).click();
  check("multi: recorded answer shows every chosen option, nav mark names the set", await page.locator(".opt.chosen").count() === 2 && (await page.locator(".item", { hasText: "Q6" }).locator(".mark").textContent()).includes("A + B"));
  await page.locator('.opt[data-opt="C"]').click();
  check("multi: changing an answer starts from the recorded set", await page.locator(".opt.staged").count() === 3 && await page.locator(".opt.chosen").count() === 0);
  await page.locator("#send").click();
  const multiEv = JSON.parse(await srv.nth(2));
  const a5 = multiEv.actions.find((a) => a.q === "q5"), a6 = multiEv.actions.find((a) => a.q === "q6");
  check("multi: send carries the option sets", a5 && a5.kind === "accept" && JSON.stringify(a5.options) === '["A","C"]' && a6 && a6.kind === "option" && JSON.stringify(a6.options) === '["A","B","C"]', JSON.stringify(multiEv.actions));

  // Typed but never added (issue #32 follow-up): Send must not silently drop what is in a
  // discussion box. Typed discussion text, on any question, and typed visual feedback go with
  // the send as if added. A typed free-text answer would answer the question, so it stays out
  // of the send, stays in its box, and the footer says so before you press Send.
  s.agent = { status: "waiting", since: new Date().toISOString(), handled: multiEv.seq };
  s.visual = { kind: "prototype", version: 2, at: new Date().toISOString(), note: "v2: narrower list", thread: [] };
  writeState(s);
  await page.waitForFunction((n) => document.getElementById("agent-status").textContent.includes("handled #" + n), multiEv.seq);
  await page.locator(".item", { hasText: "Q4" }).click();
  await page.locator("#free").fill("Unstaged free answer");
  check("typed: a free answer alone warns without enabling Send", await page.locator("#send").isDisabled() && (await page.locator("#send").textContent()) === "Send to Agent" && /Q4/.test(await page.locator("#unstaged-note").textContent()));
  await capture("typed-free-answer-only.png");
  await page.locator(".item", { hasText: "Q3" }).click();
  await page.locator("#thread-in").fill("Typed on Q3, never added");
  check("typed: discussion text alone enables Send and is counted", await page.locator("#send").isEnabled() && (await page.locator("#send").textContent()) === "Send 1 to Agent", await page.locator("#send").textContent());
  check("typed: footer names the typed message", /Q3[^·]*typed/.test(await page.locator("#staged-list").textContent()), await page.locator("#staged-list").textContent());
  await page.locator(".item", { hasText: "Q5" }).click();
  await page.locator("#thread-in").fill("Typed on Q5, also not added");
  await page.locator("#visualize").click();
  await page.locator("#feedback-in").fill("Typed visual note, not added");
  await page.locator("#visualize").click();
  await page.locator(".item", { hasText: "Q4" }).click();
  await page.locator("#free").fill("Unstaged free answer");
  check("typed: a free-text answer is not counted, the footer warns it will not be sent", (await page.locator("#send").textContent()) === "Send 3 to Agent" && /Q4/.test(await page.locator("#unstaged-note").textContent()), `${await page.locator("#send").textContent()} | ${await page.locator("#staged-list").textContent()}`);
  await capture("typed-not-added-footer.png");
  const rejectSend = (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: false, error: "deliberate rejection" }) });
  await page.route("**/send", rejectSend);
  await page.locator(".item", { hasText: "Q3" }).click();
  await page.locator("#send").click();
  await page.waitForFunction(() => document.getElementById("send-why").textContent.includes("deliberate rejection"));
  check("typed: failed Send clears the box and exposes a removable staged note", (await page.locator("#thread-in").inputValue()) === "" && await page.locator("aside .msg.staged [data-rm]").count() === 1);
  await page.reload();
  await page.locator(".item").first().waitFor();
  for (const id of ["Q3", "Q5"]) {
    await page.locator(".item", { hasText: id }).click();
    check(`typed: failed Send persists the staged note on ${id}`, (await page.locator("#thread-in").inputValue()) === "" && await page.locator("aside .msg.staged [data-rm]").count() === 1);
  }
  await page.locator("#visualize").click();
  check("typed: failed Send persists removable visual feedback", (await page.locator("#feedback-in").inputValue()) === "" && await page.locator("aside .msg.staged [data-rmf]").count() === 1);
  await page.locator("aside [data-rmf]").click();
  check("typed: failed feedback can be removed", await page.locator("aside .msg.staged").count() === 0);
  await page.locator("#feedback-in").fill("Typed visual note, not added");
  await page.locator("#visualize").click();
  await page.locator(".item", { hasText: "Q3" }).click();
  await page.locator("aside [data-rm]").click();
  check("typed: failed discussion can be removed", await page.locator("aside .msg.staged").count() === 0);
  await page.locator("#thread-in").fill("Typed on Q3, never added");
  await page.locator(".item", { hasText: "Q4" }).click();
  await page.unroute("**/send", rejectSend);
  await page.locator("#send").click();
  const typedEv = JSON.parse(await srv.nth(3));
  const typedShape = typedEv.actions.map((a) => `${a.q || "visual"}:${a.type}:${a.text || ""}`).sort();
  check("typed: the send carries discussion text from the current and navigated-away questions and the visual note, and no free-text answer",
    JSON.stringify(typedShape) === JSON.stringify(["q3:thread:Typed on Q3, never added", "q5:thread:Typed on Q5, also not added", "visual:visual-feedback:Typed visual note, not added"]), JSON.stringify(typedEv.actions));
  await page.waitForFunction((n) => document.getElementById("staged-list").textContent.includes("Sent #" + n), typedEv.seq);
  check("typed: the free-text answer is still in its box after the send", (await page.locator("#free").inputValue()) === "Unstaged free answer");
  await capture("typed-free-answer-preserved.png");
  await page.locator(".item", { hasText: "Q3" }).click();
  check("typed: the carried box is cleared and the message shows as sending", (await page.locator("#thread-in").inputValue()) === "" && (await page.locator("aside .msg.pending").textContent()).includes("Typed on Q3, never added"));
  await capture("typed-discussion-sending.png");
  await page.locator(".item", { hasText: "Q5" }).click();
  check("typed: the navigated-away box is cleared too", (await page.locator("#thread-in").inputValue()) === "");
  await page.locator("#visualize").click();
  check("typed: the visual feedback box is cleared", (await page.locator("#feedback-in").inputValue()) === "");
  await capture("typed-feedback-sending.png");
  await page.locator("#visualize").click();
  await page.reload();
  await page.locator(".item").first().waitFor();
  await page.locator(".item", { hasText: "Q3" }).click();
  check("typed: the cleared box stays cleared after a reload", (await page.locator("#thread-in").inputValue()) === "");
  // Finish ships everything staged, so it ships typed discussion text too.
  s.agent = { status: "waiting", since: new Date().toISOString(), handled: typedEv.seq };
  writeState(s);
  await page.waitForFunction((n) => document.getElementById("agent-status").textContent.includes("handled #" + n), typedEv.seq);
  await page.locator("#thread-in").fill("Typed before finishing");
  await page.route("**/send", rejectSend);
  await page.locator("#finish").click(); await page.locator("#finish-yes").click();
  await page.waitForFunction(() => document.getElementById("send-why").textContent.includes("deliberate rejection"));
  check("typed: failed Finish clears the box and exposes a removable staged note", (await page.locator("#thread-in").inputValue()) === "" && await page.locator("aside .msg.staged [data-rm]").count() === 1);
  await page.reload();
  await page.locator(".item").first().waitFor();
  await page.locator(".item", { hasText: "Q3" }).click();
  check("typed: failed Finish persists its staged note", (await page.locator("#thread-in").inputValue()) === "" && (await page.locator("aside .msg.staged").textContent()).includes("Typed before finishing"));
  await page.unroute("**/send", rejectSend);
  await page.locator("#finish").click(); await page.locator("#finish-yes").click();
  const typedFin = JSON.parse(await srv.nth(4));
  check("typed: finish carries typed discussion text before the finish action", typedFin.actions.length === 2 && typedFin.actions[0].q === "q3" && typedFin.actions[0].type === "thread" && typedFin.actions[0].text === "Typed before finishing" && typedFin.actions[1].type === "finish", JSON.stringify(typedFin.actions));
  if (evidence) writeFileSync(join(evidence, "typed-note-events.json"), JSON.stringify({ send: typedEv, finish: typedFin }, null, 2));

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
