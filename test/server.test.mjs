// Tests for server.mjs: session creation, serve (page/state/send), wait, url, sessions, pending, patch.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const SERVER = join(here, "..", "server.mjs");
const home = mkdtempSync(join(tmpdir(), "grill-home-"));
const env = { ...process.env, GRILL_HOME: home };
const tmp = (p) => mkdtempSync(join(tmpdir(), p));
const run = (args, opts = {}) => execFileSync(process.execPath, [SERVER, ...args], { encoding: "utf8", env, ...opts }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const post = (url, body) => fetch(url + "send", { method: "POST", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });

function lineReader(stream) {
  const lines = []; const waiters = []; let buf = "";
  stream.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { lines.push(buf.slice(0, i)); buf = buf.slice(i + 1); waiters.splice(0).forEach((w) => w()); } });
  const nth = (n) => new Promise((res) => { const check = () => (lines.length >= n ? res(lines[n - 1]) : waiters.push(check)); check(); });
  return { lines, nth };
}
async function startServe(session, extra = []) {
  const child = spawn(process.execPath, [SERVER, "serve", "--session", session, ...extra], { env, stdio: ["ignore", "pipe", "inherit"] });
  const out = lineReader(child.stdout);
  const ready = JSON.parse(await out.nth(1));
  const stop = () => new Promise((res) => { if (child.exitCode !== null) return res(); child.on("exit", res); child.kill(); });
  return { child, ready, out, stop };
}
const newSession = (cwd, topic = "Fonts") => JSON.parse(run(["new", "--topic", topic], { cwd }));

test("new: outside git the key comes from the cwd; state.json skeleton is written", () => {
  const cwd = tmp("grill-nogit-");
  const out = newSession(cwd);
  const real = realpathSync(cwd);
  assert.equal(out.project, real);
  assert.equal(out.key, real.replace(/^\//, "").replace(/\//g, "-"));
  assert.ok(out.session.startsWith(join(home, "sessions", out.key) + "/"), out.session);
  const state = JSON.parse(readFileSync(join(out.session, "state.json"), "utf8"));
  assert.equal(state.topic, "Fonts");
  assert.deepEqual(state.questions, []);
  assert.equal(state.agent.status, "working");
  assert.match(state.created, /^\d{4}-\d{2}-\d{2}T/);
});

test("new: a git repo and one of its worktrees share one key; two sessions never collide", () => {
  const repo = tmp("grill-repo-");
  const git = (args, cwd) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, stdio: "pipe" });
  git(["init", "-q", "-b", "main"], repo);
  git(["commit", "-q", "--allow-empty", "-m", "init"], repo);
  const wt = join(tmp("grill-wt-"), "wt");
  git(["worktree", "add", "-q", wt, "-b", "side"], repo);
  const a = newSession(repo), b = newSession(wt), c = newSession(repo);
  assert.equal(a.key, b.key);
  assert.equal(a.project, realpathSync(repo));
  assert.equal(b.project, realpathSync(repo));
  assert.notEqual(a.session, c.session);
});

test("serve: ready line + server.json, page, state, send appends the same line it prints, bad bodies are 400, seq survives restart", async (t) => {
  const { session } = newSession(tmp("grill-s-"));
  const s = await startServe(session); t.after(s.stop);
  assert.equal(s.ready.type, "ready");
  assert.match(s.ready.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
  assert.equal(s.ready.session, session);
  assert.equal(JSON.parse(readFileSync(join(session, "server.json"), "utf8")).url, s.ready.url);

  const html = await (await fetch(s.ready.url)).text();
  assert.match(html, /<textarea/);
  const state = await (await fetch(s.ready.url + "state")).json();
  assert.equal(state.topic, "Fonts");

  const actions = [{ q: "q1", type: "answer", kind: "text", text: "B, bundle them" }];
  const r1 = await post(s.ready.url, { actions });
  assert.equal(r1.status, 200);
  assert.deepEqual(await r1.json(), { ok: true, seq: 1 });
  const ev = JSON.parse(await s.out.nth(2));
  assert.equal(ev.type, "send"); assert.equal(ev.seq, 1); assert.equal(ev.session, session);
  assert.deepEqual(ev.actions, actions);
  assert.match(ev.at, /^\d{4}-\d{2}-\d{2}T/);
  const fileLines = readFileSync(join(session, "events.jsonl"), "utf8").trim().split("\n");
  assert.equal(fileLines.length, 1);
  assert.equal(fileLines[0], s.out.lines[1]);

  assert.equal((await post(s.ready.url, "nope")).status, 400);
  assert.equal((await post(s.ready.url, { actions: [] })).status, 400);
  assert.equal((await post(s.ready.url, { actions: "x" })).status, 400);
  await sleep(100);
  assert.equal(s.out.lines.length, 2, "bad bodies print nothing");
  assert.equal(readFileSync(join(session, "events.jsonl"), "utf8").trim().split("\n").length, 1);

  await s.stop();
  const s2 = await startServe(session); t.after(s2.stop);
  const r2 = await post(s2.ready.url, { actions: [{ q: "q1", type: "thread", text: "why not C?" }] });
  assert.deepEqual(await r2.json(), { ok: true, seq: 2 });
  assert.equal(JSON.parse(await s2.out.nth(2)).seq, 2);
});

test("wait: blocks for a seq newer than --after (default: current last), prints it, exits 0; exit 3 on timeout", async (t) => {
  const { session } = newSession(tmp("grill-w-"));
  const s = await startServe(session); t.after(s.stop);
  await post(s.ready.url, { actions: [{ q: "q1", type: "defer" }] });
  await s.out.nth(2);

  const w = spawn(process.execPath, [SERVER, "wait", "--session", session, "--after", "1", "--timeout", "5"], { env, stdio: ["ignore", "pipe", "inherit"] });
  const wo = lineReader(w.stdout);
  await sleep(400);
  assert.equal(wo.lines.length, 0, "nothing printed before a new send");
  await post(s.ready.url, { actions: [{ q: "q1", type: "answer", kind: "option", option: "A" }] });
  const code = await new Promise((res) => w.on("exit", res));
  assert.equal(code, 0);
  assert.equal(wo.lines.length, 1);
  assert.equal(JSON.parse(wo.lines[0]).seq, 2);

  const w2 = spawn(process.execPath, [SERVER, "wait", "--session", session, "--timeout", "5"], { env, stdio: ["ignore", "pipe", "inherit"] });
  const wo2 = lineReader(w2.stdout);
  await sleep(300);
  await post(s.ready.url, { actions: [{ q: "q1", type: "reopen" }] });
  assert.equal(await new Promise((res) => w2.on("exit", res)), 0);
  assert.equal(JSON.parse(wo2.lines[0]).seq, 3, "default --after skips everything already on disk");

  const w3 = spawn(process.execPath, [SERVER, "wait", "--session", session, "--timeout", "0.5"], { env, stdio: ["ignore", "pipe", "inherit"] });
  const wo3 = lineReader(w3.stdout);
  assert.equal(await new Promise((res) => w3.on("exit", res)), 3);
  assert.equal(wo3.lines.length, 0);
});

test("serve: /visual serves the session's visual.html (no-store), 404 JSON when absent", async (t) => {
  const { session } = newSession(tmp("grill-v-"));
  const s = await startServe(session); t.after(s.stop);
  const miss = await fetch(s.ready.url + "visual");
  assert.equal(miss.status, 404);
  assert.deepEqual(await miss.json(), { error: "no visual" });
  const html = "<!doctype html><title>v</title><h1>Prototype</h1>";
  writeFileSync(join(session, "visual.html"), html);
  const hit = await fetch(s.ready.url + "visual?v=1");
  assert.equal(hit.status, 200);
  assert.match(hit.headers.get("content-type"), /^text\/html/);
  assert.equal(hit.headers.get("cache-control"), "no-store");
  assert.equal(await hit.text(), html);
});

test("url: prints the running server's url; fails fast when there is none", async (t) => {
  const { session } = newSession(tmp("grill-u-"));
  assert.throws(() => run(["url", "--session", session, "--timeout", "0.3"]));
  const s = await startServe(session); t.after(s.stop);
  assert.equal(run(["url", "--session", session]), s.ready.url);
});

test("serve: reuses the last port from server.json, falls back to ephemeral when it is taken; --port wins", async (t) => {
  const { session } = newSession(tmp("grill-p-"));
  const s1 = await startServe(session); t.after(s1.stop);
  const port = Number(new URL(s1.ready.url).port);
  assert.equal(JSON.parse(readFileSync(join(session, "server.json"), "utf8")).port, port);
  await s1.stop();
  const s2 = await startServe(session); t.after(s2.stop);
  assert.equal(s2.ready.url, s1.ready.url, "same port after restart");
  await s2.stop();
  const blocker = createServer(); await new Promise((r) => blocker.listen(port, "127.0.0.1", r)); t.after(() => blocker.close());
  const s3 = await startServe(session); t.after(s3.stop);
  assert.notEqual(new URL(s3.ready.url).port, String(port), "falls back when the port is taken");
  assert.equal((await fetch(s3.ready.url + "state")).status, 200);
  await s3.stop(); await new Promise((r) => blocker.close(r));
  const s4 = await startServe(session, ["--port", "0"]); t.after(s4.stop);
  assert.notEqual(new URL(s4.ready.url).port, String(port), "explicit --port 0 skips reuse");
});

test("sessions: lists this project's sessions newest first, unfinished by default, --all includes finished", async () => {
  const cwd = tmp("grill-ls-");
  const a = newSession(cwd, "First topic");
  await sleep(20);
  const b = newSession(cwd, "Second topic");
  await sleep(20);
  const c = newSession(cwd, "Finished topic");
  const stateOf = (dir) => JSON.parse(readFileSync(join(dir, "state.json"), "utf8"));
  const write = (dir, st) => writeFileSync(join(dir, "state.json"), JSON.stringify(st));
  const sb = stateOf(b.session);
  sb.agent = { status: "waiting", since: "x", handled: 2 };
  sb.questions = [
    { id: "q1", round: 1, status: "answered" }, { id: "q2", round: 1, status: "open" },
    { id: "q3", round: 2, status: "deferred" }, { id: "q4", round: 2, status: "reopened" },
  ];
  write(b.session, sb);
  writeFileSync(join(b.session, "events.jsonl"), '{"seq":1}\n{"seq":2}\n{"seq":3}\n');
  const sc = stateOf(c.session); sc.finished = { doc: "docs/x.md", at: "y" }; write(c.session, sc);

  const lines = run(["sessions"], { cwd }).split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => l.session), [b.session, a.session]);
  assert.deepEqual(lines[0], { session: b.session, id: b.id, topic: "Second topic", created: sb.created, finished: null, open: 2, answered: 1, handled: 2, lastSeq: 3 });
  assert.deepEqual(lines[1], { session: a.session, id: a.id, topic: "First topic", created: stateOf(a.session).created, finished: null, open: 0, answered: 0, handled: 0, lastSeq: 0 });
  const all = run(["sessions", "--all"], { cwd }).split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(all.map((l) => l.session), [c.session, b.session, a.session]);
  assert.deepEqual(all[0].finished, { doc: "docs/x.md", at: "y" });
  assert.equal(run(["sessions"], { cwd: tmp("grill-empty-") }), "");
});

test("pending: prints the events past agent.handled, nothing when caught up", async (t) => {
  const { session } = newSession(tmp("grill-pd-"));
  const s = await startServe(session); t.after(s.stop);
  for (const k of ["A", "B", "C"]) await post(s.ready.url, { actions: [{ q: "q1", type: "answer", kind: "option", option: k }] });
  await s.out.nth(4);
  const st = JSON.parse(readFileSync(join(session, "state.json"), "utf8"));
  st.agent.handled = 1; writeFileSync(join(session, "state.json"), JSON.stringify(st));
  const out = run(["pending", "--session", session]).split("\n");
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((l) => JSON.parse(l).seq), [2, 3]);
  assert.equal(out[0], s.out.lines[2], "prints the exact stored lines");
  st.agent.handled = 3; writeFileSync(join(session, "state.json"), JSON.stringify(st));
  assert.equal(run(["pending", "--session", session]), "");
  delete st.agent.handled; writeFileSync(join(session, "state.json"), JSON.stringify(st));
  assert.equal(run(["pending", "--session", session]).split("\n").length, 3, "no handled means everything is pending");
});

// ---- patch: the agent's only way to write state.json ----
const T0 = "2026-09-01T10:00:00.000Z";
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const stateOf = (session) => JSON.parse(readFileSync(join(session, "state.json"), "utf8"));
const rawState = (session) => readFileSync(join(session, "state.json"), "utf8");
const leftovers = (session) => readdirSync(session).filter((f) => !["state.json", "events.jsonl", "server.json"].includes(f));
const qn = (id, round, extra = {}) => ({
  id, round, deps: [], title: `Title ${id}`, body: `Body ${id}`,
  options: [{ k: "A", text: "Alpha" }, { k: "B", text: "Beta" }], rec: { option: "A", why: "Alpha is simpler." },
  status: "open", durable: false, updated: false, thread: [], ...extra,
});
function seeded(fields = {}) {
  const { session } = newSession(tmp("grill-pt-"), "Patch topic");
  const st = { ...stateOf(session), agent: { status: "waiting", since: T0, handled: 0 }, ...fields };
  writeFileSync(join(session, "state.json"), JSON.stringify(st, null, 2));
  return session;
}
function patch(session, body, extra = []) {
  const input = body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body);
  const r = spawnSync(process.execPath, [SERVER, "patch", "--session", session, ...extra], { env, input, encoding: "utf8" });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
function applied(session, body, extra) {
  const r = patch(session, body, extra);
  assert.equal(r.code, 0, `patch failed: ${r.err}`);
  assert.equal(r.err, "");
  return r;
}
// A time the server stamped: ISO, and taken while the patch between t1 and t2 ran.
function stampedBetween(at, t1, t2, what) {
  assert.match(String(at), ISO, `${what} is an ISO time`);
  const t = Date.parse(at);
  assert.ok(t >= t1 - 1000 && t <= t2 + 1000, `${what} (${at}) was stamped by this patch`);
}
function rejected(session, body, pattern, extra) {
  const before = rawState(session);
  const r = patch(session, body, extra);
  assert.notEqual(r.code, 0, `expected a rejection for ${typeof body === "string" ? body : JSON.stringify(body)}`);
  assert.equal(r.out, "", "nothing on stdout when rejected");
  assert.match(r.err, /^grill: [^\n]+\n$/, "exactly one line on stderr");
  if (pattern) assert.match(r.err, pattern);
  assert.equal(rawState(session), before, "state.json untouched");
  assert.deepEqual(leftovers(session), [], "no temp file left behind");
  return r;
}

test("patch: agent and visual merge one level; other top-level keys are replaced whole; stdout is one short line", () => {
  const session = seeded({
    note: "old note", doc: "docs/a-design.md",
    agent: { status: "working", since: T0, handled: 3 },
    questions: [qn("q1", 1), qn("q2", 1, { status: "answered", answer: { kind: "accept" } })],
    visual: { kind: "prototype", version: 2, at: T0, note: "v2: first", stale: true, drawing: { since: T0, seq: 3 }, thread: [{ who: "user", text: "bigger", at: T0 }] },
  });
  const r = applied(session, {
    agent: { handled: 4 },
    visual: { stale: false, note: "v3: bigger", drawing: { since: "2026-09-01T11:00:00.000Z", seq: 4 } },
    note: "new note", doc: "docs/b-design.md", finished: { doc: "docs/b-design.md", visual: "docs/b-visual.html", at: T0 },
  });
  const st = stateOf(session);
  assert.deepEqual(st.agent, { status: "working", since: T0, handled: 4 });
  assert.deepEqual(st.visual, { kind: "prototype", version: 2, at: T0, note: "v3: bigger", stale: false, drawing: { since: "2026-09-01T11:00:00.000Z", seq: 4 }, thread: [{ who: "user", text: "bigger", at: T0 }] });
  assert.equal(st.note, "new note");
  assert.equal(st.doc, "docs/b-design.md");
  assert.equal(st.topic, "Patch topic", "untouched keys stay");
  assert.equal(st.questions.length, 2);

  assert.match(r.out, /^[^\n]+\n$/, "exactly one line on stdout");
  assert.ok(r.out.length < 120, `short: ${r.out}`);
  assert.deepEqual(JSON.parse(r.out), { ok: true, questions: 2, open: 1, handled: 4, bytes: statSync(join(session, "state.json")).size });
  for (const leak of ["Patch topic", "Title q1", "bigger", "new note"]) assert.ok(!r.out.includes(leak), `stdout never echoes the state (${leak})`);
  assert.deepEqual(leftovers(session), [], "no temp file left behind");

  applied(session, { finished: { doc: "docs/c-design.md", at: T0 } });
  assert.deepEqual(stateOf(session).finished, { doc: "docs/c-design.md", at: T0 }, "finished is replaced whole, not merged");
});

test("patch: questions merge one level by id; each given field replaces that field whole", () => {
  const explore = { at: T0, rows: [{ option: "A", pros: ["p"], cons: ["c"] }] };
  const session = seeded({
    questions: [
      qn("q1", 1, { updated: true, explore, thread: [{ who: "user", text: "hm", at: T0 }, { who: "agent", text: "ok", at: T0 }] }),
      qn("q2", 1),
    ],
  });
  const before = stateOf(session);
  applied(session, { questions: [{ id: "q1", status: "answered", answer: { kind: "option", option: "B" }, rec: { option: "B" }, updated: false, options: [{ k: "A", text: "Alpha" }, { k: "B", text: "Beta" }, { k: "C", text: "Gamma" }] }] });
  const st = stateOf(session);
  assert.deepEqual(st.questions.map((q) => q.id), ["q1", "q2"], "order kept, nothing appended");
  const q1 = st.questions[0];
  assert.deepEqual(q1.rec, { option: "B" }, "rec replaced whole, not deep-merged");
  assert.deepEqual(q1.answer, { kind: "option", option: "B" });
  assert.equal(q1.status, "answered");
  assert.equal(q1.updated, false);
  assert.equal(q1.options.length, 3);
  assert.equal(q1.title, "Title q1");
  assert.equal(q1.body, "Body q1");
  assert.deepEqual(q1.explore, explore);
  assert.deepEqual(q1.thread, before.questions[0].thread, "thread untouched when the patch has none");
  assert.deepEqual(st.questions[1], before.questions[1], "other questions untouched");
});

test("patch: a new id with a title is appended with defaults; an unknown id without a title is rejected, state untouched", () => {
  const session = seeded({ questions: [qn("q1", 1)] });
  applied(session, { questions: [
    { id: "q2", round: 2, deps: ["q1"], title: "Second", body: "B2", options: [{ k: "A", text: "Yes" }], rec: { option: "A", why: "w" }, durable: true },
    { id: "q3", round: 2, title: "Free text", body: "B3", rec: { text: "Something", why: "w" } },
  ] });
  const st = stateOf(session);
  assert.deepEqual(st.questions.map((q) => q.id), ["q1", "q2", "q3"]);
  assert.deepEqual(st.questions[1], { id: "q2", round: 2, deps: ["q1"], title: "Second", body: "B2", options: [{ k: "A", text: "Yes" }], rec: { option: "A", why: "w" }, durable: true, status: "open", thread: [], updated: false });
  assert.deepEqual(st.questions[2], { id: "q3", round: 2, title: "Free text", body: "B3", rec: { text: "Something", why: "w" }, status: "open", deps: [], options: [], thread: [], durable: false, updated: false });

  rejected(session, { agent: { handled: 1 }, questions: [{ id: "Q1", status: "answered", answer: { kind: "accept" } }] }, /Q1/);
  rejected(session, { questions: [{ id: "q9", round: 3, title: "No rec" }] }, /q9.*rec/);
  rejected(session, { questions: [{ id: "q9", title: "No round", rec: { option: "A" } }] }, /q9.*round/);
  rejected(session, { questions: [{ status: "open" }] }, /id/);
});

test("patch: thread and visual.queued append; appended messages without at get the current time", () => {
  const m = (who, text, at = T0) => ({ who, text, at });
  const session = seeded({
    questions: [qn("q1", 1, { thread: [m("user", "first")] })],
    visual: { kind: "diagram", version: 1, at: T0, thread: [m("agent", "v1 drawn")], drawing: { since: T0, seq: 1 }, queued: ["feedback: bigger"] },
  });
  const t1 = Date.now();
  applied(session, {
    questions: [{ id: "q1", thread: [m("user", "why?", "2026-09-01T10:05:00.000Z"), { who: "agent", text: "because" }] },
      { id: "q2", round: 2, title: "New", rec: { text: "t", why: "w" }, thread: [{ who: "agent", text: "context" }] }],
    visual: { thread: [{ who: "user", text: "smaller" }], queued: ["feedback: smaller"] },
  });
  const t2 = Date.now();
  const st = stateOf(session);
  const within = (at) => { assert.match(at, ISO); const t = Date.parse(at); assert.ok(t >= t1 - 1000 && t <= t2 + 1000, at); };
  const th = st.questions[0].thread;
  assert.deepEqual(th.slice(0, 2), [m("user", "first"), m("user", "why?", "2026-09-01T10:05:00.000Z")], "existing kept, given at kept");
  assert.equal(th.length, 3);
  assert.equal(th[2].text, "because"); within(th[2].at);
  within(st.questions[1].thread[0].at);
  assert.deepEqual(st.visual.thread[0], m("agent", "v1 drawn"));
  assert.equal(st.visual.thread[1].text, "smaller"); within(st.visual.thread[1].at);
  assert.deepEqual(st.visual.queued, ["feedback: bigger", "feedback: smaller"]);
  assert.deepEqual(st.visual.drawing, { since: T0, seq: 1 }, "the rest of visual is kept");
  rejected(session, { questions: [{ id: "q1", thread: { who: "user", text: "not a list" } }] }, /thread/);
  rejected(session, { visual: { queued: "not a list" } }, /queued/);
});

test("patch: the server stamps the times the agent leaves out; an explicit time in the patch always wins", () => {
  const rows = [{ option: "A", pros: ["p"], cons: ["c"] }];
  const session = seeded({
    agent: { status: "working", since: T0, handled: 2 },
    questions: [qn("q1", 1), qn("q2", 1)],
    visual: { kind: "prototype", version: 1, at: T0, note: "v1", stale: false, thread: [], drawing: { since: T0, seq: 2 } },
  });

  // Left out: agent.since (status given), explore.at (known and new question), a bumped
  // visual's at, the next draw's drawing.since, finished.at.
  let t1 = Date.now();
  applied(session, {
    agent: { status: "waiting", handled: 3 },
    questions: [
      { id: "q1", explore: { rows } },
      { id: "q3", round: 2, title: "New", rec: { text: "t", why: "w" }, explore: { rows } },
    ],
    visual: { version: 2, note: "v2: bigger", drawing: { seq: 3 } },
    finished: { doc: "docs/x-design.md" },
  });
  let t2 = Date.now();
  let st = stateOf(session);
  stampedBetween(st.agent.since, t1, t2, "agent.since");
  assert.equal(st.agent.status, "waiting");
  assert.equal(st.agent.handled, 3);
  stampedBetween(st.questions[0].explore.at, t1, t2, "q1.explore.at");
  assert.deepEqual(st.questions[0].explore.rows, rows);
  stampedBetween(st.questions[2].explore.at, t1, t2, "q3.explore.at (new question)");
  stampedBetween(st.visual.at, t1, t2, "visual.at on a version bump");
  assert.equal(st.visual.version, 2);
  stampedBetween(st.visual.drawing.since, t1, t2, "visual.drawing.since");
  assert.equal(st.visual.drawing.seq, 3);
  stampedBetween(st.finished.at, t1, t2, "finished.at");
  assert.equal(st.finished.doc, "docs/x-design.md");

  // Given: every explicit time is kept as written.
  const at = (m) => `2026-09-01T12:0${m}:00.000Z`;
  applied(session, {
    agent: { status: "working", since: at(1) },
    questions: [{ id: "q2", explore: { at: at(2), rows } }],
    visual: { version: 3, at: at(3), drawing: { since: at(4), seq: 4 } },
    finished: { doc: "docs/x-design.md", visual: "docs/x-visual.html", at: at(5) },
  });
  st = stateOf(session);
  assert.equal(st.agent.since, at(1));
  assert.equal(st.questions[1].explore.at, at(2));
  assert.equal(st.visual.at, at(3));
  assert.equal(st.visual.drawing.since, at(4));
  assert.equal(st.finished.at, at(5));

  // Not asked for: no status, an unchanged version, no drawing, no explore → nothing restamped.
  const before = stateOf(session);
  applied(session, { agent: { handled: 5 }, visual: { version: 3, stale: true }, questions: [{ id: "q2", status: "deferred" }] });
  st = stateOf(session);
  assert.equal(st.agent.since, before.agent.since, "agent.since kept when the patch gives no status");
  assert.equal(st.visual.at, before.visual.at, "visual.at kept when the version does not change");
  assert.deepEqual(st.visual.drawing, before.visual.drawing, "drawing untouched");
  assert.deepEqual(st.questions[1].explore, before.questions[1].explore, "explore untouched");
  assert.deepEqual(st.finished, before.finished, "finished untouched");

  // finished is still replaced whole: re-given without at, it is stamped anew.
  t1 = Date.now();
  applied(session, { finished: { doc: "docs/x-design.md", visual: "docs/x-visual.html" } });
  t2 = Date.now();
  stampedBetween(stateOf(session).finished.at, t1, t2, "finished.at when finished is re-given");
});

test("patch: null deletes a key at any level", () => {
  const session = seeded({
    note: "every branch settled",
    questions: [qn("q1", 1, { status: "answered", answer: { kind: "accept" } }), qn("q2", 1)],
    visual: { kind: "prototype", version: 3, at: T0, note: "v3", stale: false, drawing: { since: T0, seq: 5 }, queued: ["a"], thread: [] },
  });
  applied(session, { note: null, questions: [{ id: "q1", status: "reopened", answer: null }], visual: { drawing: null, queued: null } });
  let st = stateOf(session);
  assert.ok(!("note" in st));
  assert.ok(!("answer" in st.questions[0]));
  assert.equal(st.questions[0].status, "reopened");
  assert.deepEqual(st.visual, { kind: "prototype", version: 3, at: T0, note: "v3", stale: false, thread: [] });
  applied(session, { visual: null, note: "The draw failed; click Visualize to try again." });
  st = stateOf(session);
  assert.ok(!("visual" in st));
  assert.equal(st.note, "The draw failed; click Visualize to try again.");
});

test("patch: terms are keyed by term; a known term is replaced whole, a new one appended", () => {
  const session = seeded({ terms: [{ term: "round", def: "One turn of questions.", avoid: ["batch"] }, { term: "send", def: "One press.", avoid: [] }] });
  applied(session, { terms: [{ term: "round", def: "The frontier of one turn." }, { term: "frontier", def: "Askable now.", avoid: ["queue"] }] });
  assert.deepEqual(stateOf(session).terms, [
    { term: "round", def: "The frontier of one turn." },
    { term: "send", def: "One press.", avoid: [] },
    { term: "frontier", def: "Askable now.", avoid: ["queue"] },
  ]);
  rejected(session, { terms: [{ def: "no term" }] }, /term/);
});

test("patch: invalid JSON, a failed validation, a bad shape, or a missing state.json exits non-zero with one stderr line and leaves state.json untouched", () => {
  const session = seeded({ questions: [qn("q1", 1)] });
  rejected(session, "{ nope", /JSON/);
  rejected(session, "", /empty/);
  rejected(session, "[1,2]", /object/);
  rejected(session, '"just a string"', /object/);
  rejected(session, { agent: { status: "sleeping" } }, /agent\.status/);
  rejected(session, { agent: { handled: -1 } }, /agent\.handled/);
  rejected(session, { agent: "waiting" }, /agent/);
  rejected(session, { questions: null }, /questions/);
  rejected(session, { questions: { id: "q1" } }, /questions/);
  rejected(session, { questions: [{ id: "q1", status: "done" }] }, /q1.*status/);
  rejected(session, { questions: [{ id: "q1", answer: { kind: "maybe" } }] }, /q1.*answer/);
  rejected(session, { questions: [{ id: "q1", thread: [{ who: "bot", text: "hi" }] }] }, /q1.*thread/);
  rejected(session, { visual: { kind: "painting" } }, /visual\.kind/);
  rejected(session, { visual: { stale: true } }, /visual needs kind and version/);
  rejected(session, { terms: "round" }, /terms/);
  rejected(session, '{"questions":null,"__proto__":{"questions":[]}}', /__proto__.*the patch/);
  rejected(session, '{"agent":{"status":null,"__proto__":{"status":"waiting"}}}', /__proto__.*agent/);
  rejected(session, '{"questions":[{"id":"q1","status":null,"__proto__":{"status":"open"}}]}', /__proto__.*q1/);
  rejected(session, '{"questions":[{"id":"q9","round":2,"title":"t","rec":{"why":"w"},"__proto__":{"status":"answered"}}]}', /__proto__.*q9/);

  const empty = tmp("grill-nostate-");
  const r = patch(empty, { note: "x" });
  assert.notEqual(r.code, 0);
  assert.match(r.err, /^grill: [^\n]*state\.json[^\n]*\n$/);
  assert.deepEqual(readdirSync(empty), [], "nothing created");
});

test("patch: every field the page renders must have the shape the render reads, or the patch is rejected", () => {
  const session = seeded({
    terms: [{ term: "round", def: "One turn of questions.", avoid: ["batch"] }],
    questions: [qn("q1", 1, { explore: { at: T0, rows: [{ option: "A", pros: ["p"], cons: ["c"] }] } })],
    visual: { kind: "prototype", version: 1, at: T0, note: "v1", stale: false, thread: [] },
  });
  // The page renders each term as esc(t.def) and t.avoid.map(esc): a string avoid has a
  // length but no map, and freezes the page.
  rejected(session, { terms: [{ term: "round", def: "d", avoid: "batch" }] }, /round.*avoid/);
  rejected(session, { terms: [{ term: "round", def: "d", avoid: [["batch"]] }] }, /round.*avoid/);
  rejected(session, { terms: [{ term: "round", def: ["d"] }] }, /round.*def/);
  // Each explore row is read as r.option, r.pros, r.cons: a null row throws.
  const ex = (rows, at) => ({ questions: [{ id: "q1", explore: { ...(at === undefined ? {} : { at }), rows } }] });
  rejected(session, ex([null]), /q1\.explore\.rows\[0\]/);
  rejected(session, ex(["A"]), /q1\.explore\.rows\[0\]/);
  rejected(session, ex([{ option: "A", pros: "fast", cons: ["c"] }]), /q1\.explore\.rows\[0\]\.pros/);
  rejected(session, ex([{ option: "A", pros: ["p"], cons: [{ text: "c" }] }]), /q1\.explore\.rows\[0\]\.cons/);
  rejected(session, ex([{ option: 1, pros: ["p"], cons: ["c"] }]), /q1\.explore\.rows\[0\]\.option/);
  rejected(session, ex([], 12), /q1\.explore\.at/);
  // Text the page puts on screen goes through String(): an object whose own toString is not a
  // function throws there ("Cannot convert object to primitive value"), so rendered text must be text.
  const boom = { toString: "x" };
  rejected(session, { questions: [{ id: "q1", options: [{ k: "A", text: boom }] }] }, /q1\.options/);
  rejected(session, { questions: [{ id: "q1", rec: { option: "A", why: boom } }] }, /q1\.rec\.why/);
  rejected(session, { questions: [{ id: "q1", rec: { option: ["A"], why: "w" } }] }, /q1\.rec\.option/);
  rejected(session, { questions: [{ id: "q1", rec: { text: 5, why: "w" } }] }, /q1\.rec\.text/);
  rejected(session, { questions: [{ id: "q1", status: "answered", answer: { kind: "option", option: 2 } }] }, /q1\.answer\.option/);
  rejected(session, { questions: [{ id: "q1", status: "answered", answer: { kind: "text", text: boom } }] }, /q1\.answer\.text/);
  rejected(session, { visual: { note: boom } }, /visual\.note/);
  rejected(session, { visual: { version: 2, at: 5 } }, /visual\.at/);
  rejected(session, { visual: { drawing: { since: boom, seq: 2 } } }, /visual\.drawing/);
  rejected(session, { finished: { doc: boom } }, /finished\.doc/);
  rejected(session, { finished: { doc: "docs/x.md", visual: 1 } }, /finished\.visual/);
  rejected(session, { finished: { doc: "docs/x.md", at: boom } }, /finished\.at/);

  // Every shape SKILL.md documents still goes through, including the optional parts left out.
  applied(session, {
    terms: [{ term: "round", def: "d", avoid: [] }, { term: "send", def: "One press." }],
    questions: [
      { id: "q1", status: "answered", answer: { kind: "text", text: "Neither, a third way" }, rec: { text: "t", why: "w" },
        explore: { rows: [{ option: "A", pros: ["p"], cons: [] }, { option: "B", pros: [], cons: ["c"] }] } },
      { id: "q2", round: 2, title: "No options", body: "b", rec: { why: "only a why" } },
    ],
    visual: { version: 2, note: "v2: bigger", drawing: { seq: 3 } },
    finished: { doc: "docs/x-design.md", visual: "docs/x-visual.html" },
  });
});

test("patch: a stdin that cannot be read exits non-zero with one stderr line and leaves state.json untouched", () => {
  const session = seeded({ questions: [qn("q1", 1)] });
  const before = rawState(session);
  // A directory as stdin: not a TTY, and reading it fails with EISDIR on every platform we run on.
  const fd = openSync(tmp("grill-stdin-dir-"), "r");
  let r;
  try { r = spawnSync(process.execPath, [SERVER, "patch", "--session", session], { env, stdio: [fd, "pipe", "pipe"], encoding: "utf8" }); } finally { closeSync(fd); }
  assert.notEqual(r.status, 0);
  assert.equal(r.stdout, "", "nothing on stdout");
  assert.match(r.stderr, /^grill: [^\n]*stdin[^\n]*\n$/, `exactly one grill: line on stderr, got: ${r.stderr}`);
  assert.equal(rawState(session), before, "state.json untouched");
  assert.deepEqual(leftovers(session), [], "no temp file left behind");
});

test("patch: --file reads the patch from a file instead of stdin", () => {
  const session = seeded({ questions: [qn("q1", 1)] });
  const file = join(tmp("grill-pf-"), "patch.json");
  writeFileSync(file, JSON.stringify({ agent: { handled: 7 }, questions: [{ id: "q1", status: "deferred" }] }));
  const r = applied(session, undefined, ["--file", file]);
  assert.equal(JSON.parse(r.out).handled, 7);
  assert.equal(stateOf(session).questions[0].status, "deferred");
  rejected(session, undefined, /no-such/, ["--file", join(tmp("grill-pf-"), "no-such.json")]);
});

test("patch round trip: new → patch round 1 → serve → POST /send → patch the handling → GET /state reflects it", async (t) => {
  const { session } = newSession(tmp("grill-rt-"), "Round trip");
  // The patches below are the SKILL.md shapes, with no times in them: the server stamps them.
  const r1 = applied(session, {
    agent: { status: "waiting" },
    terms: [{ term: "send", def: "One press of Send to Agent.", avoid: ["submit"] }],
    questions: [
      { id: "q1", round: 1, title: "Storage", body: "Where state lives.", options: [{ k: "A", text: "Files" }, { k: "B", text: "SQLite" }], rec: { option: "A", why: "No dependency." } },
      { id: "q2", round: 1, title: "Transport", body: "How the page talks.", options: [{ k: "A", text: "Polling" }, { k: "B", text: "SSE" }], rec: { option: "A", why: "Simplest." } },
    ],
  });
  assert.deepEqual(JSON.parse(r1.out), { ok: true, questions: 2, open: 2, handled: 0, bytes: statSync(join(session, "state.json")).size });

  const s = await startServe(session); t.after(s.stop);
  let st = await (await fetch(s.ready.url + "state")).json();
  assert.deepEqual(st.questions.map((q) => [q.id, q.status]), [["q1", "open"], ["q2", "open"]]);
  assert.equal(st.agent.status, "waiting");

  const actions = [{ q: "q1", type: "answer", kind: "accept" }, { q: "q2", type: "thread", text: "Why not SSE?" }];
  assert.deepEqual(await (await post(s.ready.url, { actions })).json(), { ok: true, seq: 1 });
  const ev = JSON.parse(await s.out.nth(2));

  applied(session, { agent: { status: "working" } });
  const working = (await (await fetch(s.ready.url + "state")).json()).agent;
  assert.equal(working.status, "working");
  assert.match(working.since, ISO);
  assert.ok(Date.parse(working.since) >= Date.parse(ev.at), `agent.since (${working.since}) stamped when work began, after the send (${ev.at})`);

  const r2 = applied(session, {
    agent: { status: "waiting", handled: ev.seq },
    questions: [
      { id: "q1", status: "answered", answer: { kind: "accept" } },
      { id: "q2", thread: [{ who: "user", text: "Why not SSE?", at: ev.at }, { who: "agent", text: "Polling survives a server restart with no reconnect logic." }] },
      { id: "q3", round: 2, deps: ["q1"], title: "File layout", body: "With files settled in Q1.", options: [{ k: "A", text: "One folder" }], rec: { option: "A", why: "Easy to find." } },
    ],
  });
  assert.deepEqual(JSON.parse(r2.out), { ok: true, questions: 3, open: 2, handled: 1, bytes: statSync(join(session, "state.json")).size });

  st = await (await fetch(s.ready.url + "state")).json();
  assert.deepEqual(st.agent.handled, 1);
  assert.equal(st.agent.status, "waiting");
  assert.ok(Date.parse(st.agent.since) >= Date.parse(working.since), "agent.since restamped when waiting began");
  assert.deepEqual(st.questions.map((q) => [q.id, q.status, q.round]), [["q1", "answered", 1], ["q2", "open", 1], ["q3", "open", 2]]);
  assert.deepEqual(st.questions[0].answer, { kind: "accept" });
  assert.deepEqual(st.questions[1].thread.map((m) => m.who), ["user", "agent"]);
  assert.match(st.questions[1].thread[1].at, ISO);
  assert.equal(st.terms[0].term, "send");
  assert.equal(run(["pending", "--session", session]), "", "nothing left to replay");
});
