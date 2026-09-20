// Records docs/demo.gif: the loop the README describes — answer a question, ask one in the
// discussion, send, watch the agent reply and open the next round, then Explore deeper,
// Visualize, and a note of feedback that redraws the prototype — driven against a real server
// and a real page.html, so the GIF cannot drift from the product without this script noticing.
//
//   PLAYWRIGHT_PKG=/path/to/node_modules/@playwright/test/index.mjs \
//     node design/record-demo.mjs [out.gif]
//
// Needs Playwright with Chromium (as test/page.e2e.mjs does) and ffmpeg on PATH. The session
// lives in a temp GRILL_HOME; nothing outside the output file is touched. The "agent" here is
// this script writing state.json between beats, at the pace a real one answers.
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..");
const out = resolve(process.argv[2] || join(repo, "docs", "demo.gif"));
const { chromium } = await import(process.env.PLAYWRIGHT_PKG || "@playwright/test");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- the session the demo shows ----
const now = new Date().toISOString();
const at = (minAgo) => new Date(Date.now() - minAgo * 60000).toISOString();

const round1 = [
  { id: "q1", round: 1, deps: [], title: "Source of truth", durable: true, updated: false, status: "answered",
    body: "Once the same note can be edited on a phone and a laptop at the same time, where does its authoritative version live?",
    options: [
      { k: "A", text: "Server authoritative. Each client keeps a cache and a queue of pending edits; the server decides what the note is." },
      { k: "B", text: "Local-first with CRDTs. Every device converges on its own and the server is a relay." },
      { k: "C", text: "Last writer wins, no queue. Simplest, and it loses anything written offline." },
    ],
    rec: { option: "A", why: "There is already one Postgres row per note and nobody on the team has shipped a CRDT. A pending-edit queue is a week of work; a CRDT layer is a quarter." },
    answer: { kind: "accept", option: "A" }, thread: [] },
  { id: "q2", round: 1, deps: [], title: "What lives offline", durable: false, updated: false, status: "answered",
    body: "Does the phone hold every note, or only the ones recently opened?",
    options: [
      { k: "A", text: "Everything. Simple rules, and the whole library is searchable on a plane." },
      { k: "B", text: "The last 200 notes, plus anything pinned. Bounded storage, a rule to explain." },
    ],
    rec: { option: "B", why: "Bounded beats simple once someone has 8,000 notes with images in them." },
    answer: { kind: "text", text: "B, but pinned notes and everything from the last 30 days" }, thread: [] },
];

const round2 = [
  { id: "q3", round: 2, deps: ["q1"], title: "Conflict resolution", durable: true, updated: false, status: "open",
    body: "Two devices edit the same note while both are offline. Both come back. What does the person who wrote them see?",
    options: [
      { k: "A", text: "Server wins silently. The later upload is dropped and that device is handed the server's copy." },
      { k: "B", text: "Keep both. The losing version is saved beside the note as a conflict copy, titled with the device and the time." },
      { k: "C", text: "Merge line by line, like git, and ask only when the same line changed on both sides." },
    ],
    rec: { option: "B", why: "Silently losing what someone wrote is the one failure they never forgive, and a conflict copy costs one row and one badge. Line merging demos well and is wrong for prose: two devices rewriting the same paragraph produce a paragraph nobody wrote." },
    thread: [] },
  { id: "q4", round: 2, deps: ["q1"], title: "When sync runs", durable: false, updated: false, status: "open",
    body: "What wakes the sync: an edit, a timer, or the network coming back?",
    options: [
      { k: "A", text: "On every edit, debounced two seconds, and on reconnect." },
      { k: "B", text: "Every thirty seconds while the app is open, and on reconnect." },
      { k: "C", text: "Only when the person pulls to sync." },
    ],
    rec: { option: "A", why: "The queue makes edit-driven sync cheap, and a debounce keeps a long typing run to one request. A timer adds latency for nothing." },
    thread: [] },
  { id: "q5", round: 2, deps: ["q2"], title: "Deleted notes", durable: false, updated: false, status: "deferred",
    body: "A note deleted offline on one device, edited offline on another. Tombstone, or resurrect?",
    options: [{ k: "A", text: "Tombstone wins; the edit lands in the trash with the note." }, { k: "B", text: "An edit resurrects the note." }],
    rec: { option: "A", why: "Deleting is the deliberate act; editing can be a stray keystroke." },
    thread: [] },
];

const base = (extra = {}) => ({
  topic: "Offline sync for the notes app",
  doc: "docs/offline-sync-design.md",
  terms: [
    { term: "Pending edit", def: "A change written on a device that the server has not acknowledged yet.", avoid: ["dirty", "unsaved"] },
    { term: "Conflict copy", def: "The losing version of a note, kept beside it rather than dropped.", avoid: ["fork", "duplicate"] },
  ],
  agent: { status: "waiting", since: at(2), handled: 0 },
  ...extra,
});

const QUESTION = "Does the debounce survive the tab being backgrounded?";
const REPLY = "Not on mobile Safari: the timer is frozen the moment you switch apps, so a debounced edit can sit unsent for hours. The reconnect flush still covers it, so the worst case is a late sync rather than a lost note. Q6 makes that explicit.";

const round3 = [
  { id: "q6", round: 3, deps: ["q4"], title: "Backgrounded tabs", durable: false, updated: false, status: "open",
    body: "A phone browser freezes timers the moment the app is backgrounded. What flushes the queue then?",
    options: [
      { k: "A", text: "Flush on visibilitychange and on pagehide, and again on reconnect." },
      { k: "B", text: "A service worker with Background Sync where it exists, the events above where it does not." },
      { k: "C", text: "Nothing. The next time the app is opened, the queue drains." },
    ],
    rec: { option: "A", why: "Two events, no new moving parts, and it covers the case you just asked about. Background Sync is Chromium-only, so it can never be the whole answer." },
    thread: [] },
  { id: "q7", round: 3, deps: ["q3"], title: "Clearing conflict copies", durable: false, updated: false, status: "open",
    body: "Conflict copies pile up. Who removes them, and when?",
    options: [
      { k: "A", text: "The person does, from a banner on the note: keep this one, or keep both." },
      { k: "B", text: "Automatically after thirty days in the trash." },
    ],
    rec: { option: "A", why: "A conflict copy exists because the machine was not sure; deleting it on a timer puts the machine back in charge of the thing it got wrong." },
    thread: [] },
];

// The pros and cons one click on Explore deeper puts in the discussion panel.
const EXPLORE = [
  { option: "A", pros: ["Works in every browser today", "No new moving parts"], cons: ["iOS can cut pagehide short"] },
  { option: "B", pros: ["Retries after the app is closed"], cons: ["Chromium only", "A second path to keep honest"] },
  { option: "C", pros: ["Nothing to build"], cons: ["A note can sit unsent for days", "Silent to the person who wrote it"] },
];

// What the draw subagent hands back for Visualize: the decisions so far as one screen, with
// the parts that are still open drawn from the recommendations and marked assumed. v2 is the
// same screen after the feedback in the demo: the conflict copy becomes a row of its own.
const FEEDBACK = "Show the conflict copy in the list too, under its note.";
const REDRAW = "Added as an indented row under the note it belongs to, with the device and time. It disappears the moment you keep one of the two.";
const prototype = (copyInList) => `<!doctype html>
<meta charset="utf-8"><title>Notes · offline sync</title>
<style>
  :root { --ink:#16181d; --ink-2:#4c525e; --ink-3:#8a909c; --line:#e4e6ea; --bg:#f5f6f8; --accent:#3b5bdb; --warn:#9a5b00; --warn-bg:#fdf3e2; }
  * { box-sizing: border-box; }
  body { margin:0; font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; color:var(--ink); background:var(--bg); }
  .app { display:grid; grid-template-columns:250px 1fr; grid-template-rows:auto 1fr auto; height:100vh; }
  .bar { grid-column:1/-1; display:flex; align-items:center; gap:12px; padding:14px 20px; background:#fff; border-bottom:1px solid var(--line); }
  .bar h1 { margin:0; font-size:17px; letter-spacing:-.01em; }
  .chip { margin-left:auto; display:flex; align-items:center; gap:7px; font-size:13px; color:var(--warn); background:var(--warn-bg); border:1px solid #f0dcb8; border-radius:999px; padding:5px 12px; }
  .chip .dot { width:7px; height:7px; border-radius:50%; background:var(--warn); }
  .list { background:#fff; border-right:1px solid var(--line); overflow:hidden; }
  .list .row { padding:13px 18px; border-bottom:1px solid var(--line); }
  .list .row.on { background:#f0f3ff; box-shadow:inset 3px 0 0 var(--accent); }
  .list .row.copy { padding-left:32px; background:#fdfaf3; }
  .list .row.copy .t { font-weight:500; color:var(--warn); }
  .list .t { font-weight:600; font-size:14px; display:flex; align-items:center; gap:6px; }
  .list .s { font-size:12.5px; color:var(--ink-3); margin-top:3px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .pending { width:7px; height:7px; border-radius:50%; background:var(--warn); flex:none; }
  .tag { font-size:10.5px; letter-spacing:.04em; text-transform:uppercase; color:var(--warn); border:1px solid #f0dcb8; background:var(--warn-bg); border-radius:4px; padding:1px 5px; }
  .note { padding:26px 34px; overflow:hidden; }
  .banner { display:flex; align-items:center; gap:12px; background:var(--warn-bg); border:1px solid #f0dcb8; border-radius:10px; padding:12px 14px; font-size:13.5px; color:var(--warn); }
  .banner b { color:#7a4800; }
  .banner .sp { margin-left:auto; display:flex; gap:8px; }
  .banner button { font:inherit; font-size:13px; white-space:nowrap; padding:6px 12px; border-radius:7px; border:1px solid #e0c99c; background:#fff; color:#7a4800; cursor:pointer; }
  .banner button.k { background:#7a4800; border-color:#7a4800; color:#fff; }
  .note h2 { font-size:24px; margin:22px 0 4px; letter-spacing:-.015em; }
  .meta { font-size:12.5px; color:var(--ink-3); }
  .note p { color:var(--ink-2); max-width:56ch; }
  .foot { grid-column:1/-1; display:flex; align-items:center; gap:8px; padding:11px 20px; background:#fff; border-top:1px solid var(--line); font-size:12.5px; color:var(--ink-3); white-space:nowrap; }
  .assumed { font-size:10.5px; letter-spacing:.04em; text-transform:uppercase; white-space:nowrap; color:var(--ink-3); border:1px dashed #c6cad3; border-radius:4px; padding:1px 5px; }
</style>
<div class="app">
  <div class="bar">
    <h1>Notes</h1>
    <span class="chip"><span class="dot"></span>Offline · 3 edits queued</span>
  </div>
  <div class="list">
    <div class="row on"><div class="t"><span class="pending"></span>Ferry timetable<span class="tag">conflict</span></div><div class="s">Last boat back is 21:40, not 22:10</div></div>
    ${copyInList ? '<div class="row copy"><div class="t">Ferry timetable</div><div class="s">Conflict copy · iPhone, 09:14</div></div>' : ""}
    <div class="row"><div class="t"><span class="pending"></span>Groceries</div><div class="s">Oat milk, tinned tomatoes, the good bread</div></div>
    <div class="row"><div class="t"><span class="pending"></span>Talk outline</div><div class="s">Open with the outage, not the architecture</div></div>
    <div class="row"><div class="t">Reading list</div><div class="s">Synced</div></div>
    <div class="row"><div class="t">Flat viewing notes</div><div class="s">Synced</div></div>
  </div>
  <div class="note">
    <div class="banner">
      <div>Also edited on <b>iPhone</b> at 09:14 while you were offline. Both versions are kept.</div>
      <div class="sp"><button class="k">Keep this one</button><button>Keep both</button></div>
    </div>
    <h2>Ferry timetable</h2>
    <div class="meta">Edited 2 minutes ago on this Mac · not yet sent</div>
    <p>Last boat back is 21:40 on weekdays and 22:10 on Saturdays. The 18:05 does not run in
      October. Cars need to be in the queue twenty minutes before departure, foot passengers ten.</p>
    <p>Conflict copy: <b>Ferry timetable (iPhone, 09:14)</b> sits directly under this note until
      you pick one.</p>
  </div>
  <div class="foot">Sent 2s after you stop typing, and on reconnect <span class="assumed">assumed · Q4</span>
    <span style="margin-left:auto">Queue flushed on visibilitychange and pagehide <span class="assumed">assumed · Q6</span></span>
  </div>
</div>
`;

// ---- session + server ----
const home = mkdtempSync(join(tmpdir(), "grill-demo-home-"));
const env = { ...process.env, GRILL_HOME: home };
const SERVER = join(repo, "server.mjs");
const { session } = JSON.parse(execFileSync(process.execPath, [SERVER, "new", "--topic", "demo", "--doc", "docs/demo.md"],
  { encoding: "utf8", env, cwd: mkdtempSync(join(tmpdir(), "grill-demo-proj-")) }));
const stateFile = join(session, "state.json");
const created = JSON.parse(readFileSync(stateFile, "utf8")).created;
const write = (s) => writeFileSync(stateFile, JSON.stringify({ ...s, project: "~/Projects/notes", created }, null, 2));

write(base({ questions: [...round1, ...round2] }));

const child = spawn(process.execPath, [SERVER, "serve", "--session", session], { env, stdio: ["ignore", "pipe", "inherit"] });
const url = await new Promise((res) => child.stdout.once("data", (d) => res(JSON.parse(String(d).split("\n")[0]).url)));

// ---- the page, with a drawn cursor so clicks are legible ----
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.addInitScript(() => {
  const draw = () => {
    const c = document.createElement("div");
    // fixed, so the body grid never sees it as a cell
    c.style.cssText = "position:fixed;left:-60px;top:-60px;width:24px;height:24px;z-index:9999;pointer-events:none;transition:transform .08s ease-out";
    c.innerHTML = '<svg viewBox="0 0 24 24" width="24" height="24"><path d="M5.5 2.2l13.2 8.2-6.1 1.2-3 6.6z" fill="#161513" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    document.body.appendChild(c);
    addEventListener("mousemove", (e) => { c.style.left = e.clientX + "px"; c.style.top = e.clientY + "px"; }, true);
    addEventListener("mousedown", () => (c.style.transform = "scale(.72)"), true);
    addEventListener("mouseup", () => (c.style.transform = ""), true);
  };
  document.readyState === "loading" ? addEventListener("DOMContentLoaded", draw) : draw();
});
await page.goto(url);
await page.locator(".card").waitFor();
await page.mouse.move(640, 700);

// ---- capture ----
const frames = mkdtempSync(join(tmpdir(), "grill-demo-frames-"));
const FPS = 10;
let n = 0, rolling = true;
const roll = (async () => {
  while (rolling) {
    const t = Date.now();
    await page.screenshot({ path: join(frames, `f${String(n++).padStart(4, "0")}.png`), animations: "allow" });
    await sleep(Math.max(0, 1000 / FPS - (Date.now() - t)));
  }
})();

// a human-paced move to the middle of a target, then a click
async function point(locator, dy = 0) {
  const b = await locator.boundingBox();
  await page.mouse.move(b.x + Math.min(b.width / 2, 260), b.y + b.height / 2 + dy, { steps: 14 });
  await sleep(240);
}
async function click(locator, dy = 0) { await point(locator, dy); await page.mouse.down(); await sleep(90); await page.mouse.up(); await sleep(260); }

// The page counts sends; the agent acknowledges one by raising handled to its number.
let seq = 0;
const waiting = () => ({ status: "waiting", since: new Date().toISOString(), handled: seq });

try {
  await sleep(1000);                                                   // the page as the agent leaves it

  await click(page.locator(".opt.rec"));                               // accept the recommendation
  await sleep(900);

  await click(page.locator(".item", { hasText: "Q4" }));               // move to the next question
  await sleep(700);

  await click(page.locator("#thread-in"));                             // ask about it in its own thread
  await page.locator("#thread-in").pressSequentially(QUESTION, { delay: 38 });
  await sleep(500);
  await click(page.locator("#stage-thread"));
  await sleep(800);

  await click(page.locator("#send"));                                  // one send ships both
  seq = 1;
  await sleep(700);

  write(base({ questions: [...round1, ...round2], agent: { status: "working", since: new Date().toISOString(), handled: 0 } }));
  await sleep(2400);                                                   // the agent reads and answers

  const answered = JSON.parse(JSON.stringify(round2));
  answered[0].status = "answered"; answered[0].answer = { kind: "accept", option: "B" };
  answered[1].thread = [{ who: "user", text: QUESTION, at: now }, { who: "agent", text: REPLY, at: now }];
  const state = base({
    questions: [...round1, ...answered, ...round3],
    agent: waiting(),
    note: "Q6 comes straight out of your question on Q4.",
  });
  write(state);
  await sleep(2200);                                                   // the reply and the new round land

  await click(page.locator(".item", { hasText: "Q6" }));               // on to the round it opened
  await sleep(1100);

  await click(page.locator("#explore"));                               // one click, its own turn
  seq = 2;
  await sleep(1400);
  state.questions.find((q) => q.id === "q6").explore = { at: new Date().toISOString(), rows: EXPLORE };
  state.agent = waiting();
  write(state);
  await sleep(2400);                                                   // pros and cons fill the panel

  await click(page.locator("#visualize"));                             // one picture of the design so far
  seq = 3;
  await sleep(900);
  state.visual = { kind: "prototype", version: 0, thread: [], stale: false, drawing: { since: new Date().toISOString(), seq } };
  state.agent = waiting();
  write(state);
  await sleep(2200);                                                   // acknowledged; a subagent draws it in the background

  writeFileSync(join(session, "visual.html"), prototype(false));
  state.visual = { kind: "prototype", version: 1, at: new Date().toISOString(), note: "v1: conflict copy kept beside the note, queued edits marked in the list", thread: [], stale: false };
  write(state);
  await sleep(2400);                                                   // it lands and the view flips by itself

  await click(page.locator("#feedback-in"));                           // say what is missing from the picture
  await page.locator("#feedback-in").pressSequentially(FEEDBACK, { delay: 38 });
  await sleep(400);
  await click(page.locator("#stage-feedback"));
  await sleep(800);

  await click(page.locator("#send"));                                  // feedback ships like any other send
  seq = 4;
  await sleep(700);
  state.visual.thread = [{ who: "user", text: FEEDBACK, at: new Date().toISOString() }, { who: "agent", text: REDRAW, at: new Date().toISOString() }];
  state.visual.drawing = { since: new Date().toISOString(), seq };
  state.agent = waiting();
  write(state);
  await sleep(2400);                                                   // answered at once, redrawn in the background

  writeFileSync(join(session, "visual.html"), prototype(true));
  state.visual = { kind: "prototype", version: 2, at: new Date().toISOString(), note: "v2: the conflict copy is a row in the list", thread: state.visual.thread, stale: false };
  write(state);
  await sleep(3200);                                                   // v2 lands in place, the note under the note
} finally {
  rolling = false;
  await roll;
  await browser.close();
  child.kill();
}

// ---- assemble ----
mkdirSync(dirname(out), { recursive: true });
const vf = `fps=${FPS},scale=1024:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=160:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`;
execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-framerate", String(FPS), "-i", join(frames, "f%04d.png"), "-filter_complex", vf, "-loop", "0", out]);
rmSync(frames, { recursive: true, force: true });
rmSync(home, { recursive: true, force: true });
console.log(`${out} · ${n} frames · ${(n / FPS).toFixed(1)}s`);
