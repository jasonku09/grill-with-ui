#!/usr/bin/env node
// grill-with-ui server. Plain Node, no dependencies, no build step.
//
//   new      --topic T [--doc P]                    create a session folder under GRILL_HOME, print {session,key,project,id,doc}
//   serve    --session DIR [--port N]               serve the page; append each Send to events.jsonl AND print the same
//                                                   line to stdout (this process is the agent's Monitor command).
//                                                   Without --port it retries the port it used last time, then falls
//                                                   back to an ephemeral one, so an open tab survives a restart.
//   sessions [--all]                                list this project's sessions (newest first; --all adds finished ones)
//   pending  --session DIR                          print every Send past agent.handled (replay on resume)
//   wait     --session DIR [--after N] [--timeout S] block until a Send newer than seq N lands, print it, exit 0
//                                                   (exit 3 on timeout) — for agents without a Monitor tool
//   url      --session DIR [--timeout S]            print the running server's url (from server.json)
//   patch    --session DIR [--file P]               apply a JSON patch (stdin, or the file P) to state.json: merge,
//                                                   validate, write atomically, print one short summary line
//
// Files (per session folder): state.json  — written only by the agent, through `patch`
//                             events.jsonl — appended only by this server, one line per Send
//                             server.json  — url, port, pid of the running server
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import tty from "node:tty";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOME = process.env.GRILL_HOME || path.join(os.homedir(), ".grill-with-ui");

function parseArgs(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) { o._.push(a); continue; }
    const k = a.slice(2), v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) o[k] = true; else { o[k] = v; i++; }
  }
  return o;
}
const print = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");
const die = (msg, code = 2) => { process.stderr.write(`grill: ${msg}\n`); process.exit(code); };
// Atomic: a temp file in the same folder, then rename, so a reader never sees half a file.
function writeJson(file, obj) {
  const text = JSON.stringify(obj, null, 2) + "\n";
  const tmp = `${file}.${process.pid}.tmp`;
  try { fs.writeFileSync(tmp, text); fs.renameSync(tmp, file); } catch (e) { fs.rmSync(tmp, { force: true }); throw e; }
  return Buffer.byteLength(text);
}
function mustSession(o) {
  if (!o.session || o.session === true) die("--session <dir> is required");
  const dir = path.resolve(o.session);
  if (!fs.existsSync(dir)) die(`no such session folder: ${dir}`);
  return dir;
}

// ---- session key: git common root (all worktrees share it), cwd outside git ----
function projectRoot(cwd) {
  try {
    const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return fs.realpathSync(path.dirname(common));
  } catch { return fs.realpathSync(cwd); }
}
const keyOf = (root) => root.replace(/^[\\/]+/, "").replace(/[\\/:]+/g, "-");
function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function cmdNew(o) {
  const project = projectRoot(process.cwd());
  const key = keyOf(project);
  const dir = path.join(HOME, "sessions", key);
  fs.mkdirSync(dir, { recursive: true });
  const id = stamp();
  let session = path.join(dir, id);
  for (let n = 2; fs.existsSync(session); n++) session = path.join(dir, `${id}-${n}`);
  fs.mkdirSync(session);
  const now = new Date().toISOString();
  writeJson(path.join(session, "state.json"), {
    topic: typeof o.topic === "string" ? o.topic : "", doc: typeof o.doc === "string" ? o.doc : "",
    project, created: now, agent: { status: "working", since: now }, terms: [], questions: [],
  });
  fs.writeFileSync(path.join(session, "events.jsonl"), "");
  print({ session, key, project, id: path.basename(session), doc: typeof o.doc === "string" ? o.doc : "" });
}

// ---- events.jsonl helpers ----
function readEvents(file) {
  if (!fs.existsSync(file)) return [];
  const out = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try { out.push({ line, ev: JSON.parse(line) }); } catch { /* partial or corrupt line: skip */ }
  }
  return out;
}
const lastSeq = (file) => readEvents(file).reduce((m, { ev }) => Math.max(m, Number(ev.seq) || 0), 0);
function readState(session) {
  try { return JSON.parse(fs.readFileSync(path.join(session, "state.json"), "utf8")); } catch { return null; }
}
const isOpen = (q) => q.status === "open" || q.status === "reopened";

// ---- sessions (for resume) ----
function cmdSessions(o) {
  const dir = path.join(HOME, "sessions", keyOf(projectRoot(process.cwd())));
  if (!fs.existsSync(dir)) return;
  const rows = [];
  for (const id of fs.readdirSync(dir)) {
    const session = path.join(dir, id);
    const st = readState(session);
    if (!st) continue;
    const qs = Array.isArray(st.questions) ? st.questions : [];
    rows.push({
      session, id, topic: st.topic || "", created: st.created || "", finished: st.finished || null,
      open: qs.filter(isOpen).length, answered: qs.filter((q) => q.status === "answered").length,
      handled: Number(st.agent && st.agent.handled) || 0, lastSeq: lastSeq(path.join(session, "events.jsonl")),
    });
  }
  rows.sort((a, b) => (b.created < a.created ? -1 : b.created > a.created ? 1 : b.id.localeCompare(a.id)));
  for (const r of rows) if (o.all || !r.finished) print(r);
}

// ---- pending (replay on resume) ----
function cmdPending(o) {
  const session = mustSession(o);
  const st = readState(session);
  const handled = Number(st && st.agent && st.agent.handled) || 0;
  for (const { line, ev } of readEvents(path.join(session, "events.jsonl"))) {
    if ((Number(ev.seq) || 0) > handled) process.stdout.write(line + "\n");
  }
}

// ---- serve ----
function cmdServe(o) {
  const session = mustSession(o);
  const events = path.join(session, "events.jsonl");
  const stateFile = path.join(session, "state.json");
  const serverFile = path.join(session, "server.json");
  const page = path.join(HERE, "page.html");
  let seq = lastSeq(events);
  let lastGoodState = null;

  const send = (res, code, body, type) => { res.writeHead(code, { "content-type": type, "cache-control": "no-store" }); res.end(body); };
  const json = (res, code, obj) => send(res, code, JSON.stringify(obj), "application/json");
  const readBody = (req) => new Promise((resolve) => { let b = ""; req.on("data", (c) => { b += c; }); req.on("end", () => resolve(b)); });

  const srv = http.createServer(async (req, res) => {
    const { pathname } = new URL(req.url, "http://x");
    if (req.method === "GET" && pathname === "/") return send(res, 200, fs.readFileSync(page), "text/html; charset=utf-8");
    if (req.method === "GET" && pathname === "/state") {
      // `patch` swaps state.json in atomically, but a hand-written file can be caught mid-write:
      // then serve the last parse that worked.
      try { const raw = fs.readFileSync(stateFile, "utf8"); JSON.parse(raw); lastGoodState = raw; } catch { /* keep lastGoodState */ }
      if (lastGoodState === null) return json(res, 404, { error: "no state" });
      return send(res, 200, lastGoodState, "application/json");
    }
    if (req.method === "GET" && pathname === "/events") return send(res, 200, fs.existsSync(events) ? fs.readFileSync(events) : "", "application/x-ndjson");
    if (req.method === "GET" && pathname === "/visual") {
      const visual = path.join(session, "visual.html"); // written only by the agent; shown by the page in a sandboxed iframe
      if (!fs.existsSync(visual)) return json(res, 404, { error: "no visual" });
      return send(res, 200, fs.readFileSync(visual), "text/html; charset=utf-8");
    }
    if (req.method === "POST" && pathname === "/send") {
      let parsed;
      try { parsed = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: "body must be JSON" }); }
      if (!parsed || !Array.isArray(parsed.actions) || parsed.actions.length === 0) return json(res, 400, { error: "actions must be a non-empty array" });
      const line = JSON.stringify({ type: "send", seq: ++seq, at: new Date().toISOString(), session, actions: parsed.actions });
      fs.appendFileSync(events, line + "\n");
      process.stdout.write(line + "\n"); // this is what wakes the agent
      return json(res, 200, { ok: true, seq });
    }
    json(res, 404, { error: "not found" });
  });
  // Port choice: an explicit --port wins; otherwise retry last time's port (so an open tab
  // just resumes polling after a restart) and fall back to ephemeral if it is taken.
  const explicit = o.port !== undefined && o.port !== true;
  let attempt = explicit ? Number(o.port) : rememberedPort(serverFile);
  srv.on("error", (e) => {
    if (!srv.listening && !explicit && attempt !== 0 && e.code === "EADDRINUSE") { attempt = 0; srv.listen(0, "127.0.0.1"); return; }
    die(`server error: ${e.message}`, 1);
  });
  srv.on("listening", () => {
    const { port } = srv.address();
    const url = `http://127.0.0.1:${port}/`;
    writeJson(serverFile, { url, port, pid: process.pid, started: new Date().toISOString() });
    print({ type: "ready", url, session });
  });
  srv.listen(attempt, "127.0.0.1");
  // server.json stays on exit on purpose: it remembers the port for the next serve, and
  // `url` checks the pid before trusting it.
  const bye = () => process.exit(0);
  process.on("SIGINT", bye); process.on("SIGTERM", bye); process.on("SIGHUP", bye);
}

// ---- wait (blocking, for agents without a Monitor tool) ----
function cmdWait(o) {
  const session = mustSession(o);
  const events = path.join(session, "events.jsonl");
  const after = o.after !== undefined && o.after !== true ? Number(o.after) : lastSeq(events);
  const deadline = Date.now() + Number(o.timeout !== undefined && o.timeout !== true ? o.timeout : 480) * 1000;
  const tick = () => {
    for (const { line, ev } of readEvents(events)) {
      if ((Number(ev.seq) || 0) > after) { process.stdout.write(line + "\n"); process.exit(0); }
    }
    if (Date.now() >= deadline) process.exit(3);
    setTimeout(tick, 250);
  };
  tick();
}

function rememberedPort(serverFile) {
  try { const p = Number(JSON.parse(fs.readFileSync(serverFile, "utf8")).port); return Number.isInteger(p) && p > 0 ? p : 0; } catch { return 0; }
}

// ---- url ----
function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
function cmdUrl(o) {
  const session = mustSession(o);
  const serverFile = path.join(session, "server.json");
  const deadline = Date.now() + Number(o.timeout !== undefined && o.timeout !== true ? o.timeout : 5) * 1000;
  const tick = () => {
    try {
      const { url, pid } = JSON.parse(fs.readFileSync(serverFile, "utf8"));
      if (url && (!pid || alive(pid))) { process.stdout.write(url + "\n"); process.exit(0); }
    } catch { /* not there yet */ }
    if (Date.now() >= deadline) die(`no running server for ${session}`, 1);
    setTimeout(tick, 100);
  };
  tick();
}

// ---- patch (the agent's only way to write state.json) ----
// The agent sends only what changed, so the whole state never passes through its context.
//   null deletes a key, at any level
//   agent, visual: merge one level (visual.thread and visual.queued append)
//   questions: keyed by id. A known id merges one level (its thread appends). An unknown id
//     with a title is a new question, appended with defaults; without a title it is an error.
//   terms: keyed by term; a known term is replaced whole, a new one appended
//   any other key: replaced whole
// Before the merge, the server stamps the times the agent leaves out (see stampTimes).
class PatchError extends Error {}
const bad = (msg) => { throw new PatchError(msg); };
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const oneLine = (s) => String(s).replace(/\s+/g, " ").trim();
const fieldsOf = (p, where) => {
  if (Object.hasOwn(p, "__proto__")) bad(`"__proto__" in ${where} is not a state.json field`);
  return Object.entries(p);
};
// A value written whole carries no null-valued keys: null means "delete" everywhere.
const clean = (v) => (Array.isArray(v) ? v.map(clean)
  : isObj(v) ? Object.fromEntries(Object.entries(v).filter(([, x]) => x !== null).map(([k, x]) => [k, clean(x)])) : v);
const newQuestionDefaults = () => ({ status: "open", deps: [], options: [], thread: [], durable: false, updated: false });
const THREAD = ["thread"];
const VISUAL_APPENDS = ["thread", "queued"];

// Agents do not reliably know the current time, so the server stamps every time the patch
// leaves out (or gives as null); an explicit time in the patch always wins:
//   agent.since          when the patch gives agent.status
//   <q>.explore.at       when the patch gives a question's explore
//   visual.at            when the patch changes visual.version
//   visual.drawing.since when the patch gives visual.drawing
//   finished.at          when the patch gives finished
//   at on each appended message in a question's thread or visual.thread
// Returns a stamped copy of the patch; shapes it does not recognise are left for the merge
// and validation to reject.
function stampTimes(p, state, now) {
  const fill = (o, k) => (isObj(o) && o[k] == null ? { ...o, [k]: now } : o);
  const messages = (list) => (Array.isArray(list) ? list.map((m) => fill(m, "at")) : list);
  const out = { ...p };
  if (isObj(out.agent) && out.agent.status != null) out.agent = fill(out.agent, "since");
  if (isObj(out.finished)) out.finished = fill(out.finished, "at");
  if (Array.isArray(out.questions)) {
    out.questions = out.questions.map((q) => {
      if (!isObj(q)) return q;
      const s = { ...q };
      if (isObj(s.explore)) s.explore = fill(s.explore, "at");
      if ("thread" in s) s.thread = messages(s.thread);
      return s;
    });
  }
  if (isObj(out.visual)) {
    let v = { ...out.visual };
    const current = isObj(state) && isObj(state.visual) ? state.visual.version : undefined;
    if (v.version != null && v.version !== current) v = fill(v, "at");
    if (isObj(v.drawing)) v.drawing = fill(v.drawing, "since");
    if ("thread" in v) v.thread = messages(v.thread);
    out.visual = v;
  }
  return out;
}

function appendTo(current, added, where) {
  if (!Array.isArray(added)) bad(`${where} in a patch must be an array of the new entries to append`);
  if (current !== undefined && !Array.isArray(current)) bad(`${where} in state.json is not an array`);
  return [...(current || []), ...added.map(clean)];
}
// One level: each key given replaces that key (null deletes it); keys in `appends` append.
function mergeOne(current, p, where, appends = []) {
  if (!isObj(p)) bad(`${where} in a patch must be an object`);
  const out = isObj(current) ? { ...current } : {};
  for (const [k, v] of fieldsOf(p, where)) {
    if (v === null) delete out[k];
    else if (appends.includes(k)) out[k] = appendTo(out[k], v, `${where}.${k}`);
    else out[k] = clean(v);
  }
  return out;
}
function patchQuestions(current, list) {
  if (!Array.isArray(list)) bad("questions in a patch must be an array of entries, each with an id");
  if (!Array.isArray(current)) bad("questions in state.json is not an array");
  const qs = current.slice();
  for (const p of list) {
    if (!isObj(p) || typeof p.id !== "string" || !p.id) bad("every question entry in a patch needs a string id");
    const i = qs.findIndex((q) => isObj(q) && q.id === p.id);
    if (i >= 0) { qs[i] = mergeOne(qs[i], p, p.id, THREAD); continue; }
    if (p.title == null) {
      const ids = qs.map((q) => q && q.id).join(", ") || "none yet";
      bad(`no question ${JSON.stringify(p.id)} in state.json (ids: ${ids}); a new question needs round, title, and rec`);
    }
    const missing = ["round", "rec"].filter((k) => p[k] == null);
    if (missing.length) bad(`new question ${p.id} needs ${missing.join(" and ")}`);
    const q = mergeOne({}, p, p.id, THREAD);
    for (const [k, d] of Object.entries(newQuestionDefaults())) if (!(k in q)) q[k] = d;
    qs.push(q);
  }
  return qs;
}
function patchTerms(current, list) {
  if (!Array.isArray(list)) bad("terms in a patch must be an array of entries, each with a term");
  if (current != null && !Array.isArray(current)) bad("terms in state.json is not an array");
  const ts = (current || []).slice();
  for (const t of list) {
    if (!isObj(t) || typeof t.term !== "string" || !t.term) bad("every term entry in a patch needs a string term");
    const i = ts.findIndex((x) => isObj(x) && x.term === t.term);
    if (i >= 0) ts[i] = clean(t); else ts.push(clean(t));
  }
  return ts;
}
function applyPatch(state, p, now) {
  if (!isObj(p)) bad("the patch must be a JSON object shaped like state.json");
  const out = { ...state };
  for (const [k, v] of fieldsOf(stampTimes(p, state, now), "the patch")) {
    if (v === null) delete out[k];
    else if (k === "agent") out.agent = mergeOne(out.agent, v, "agent");
    else if (k === "visual") out.visual = mergeOne(out.visual, v, "visual", VISUAL_APPENDS);
    else if (k === "questions") out.questions = patchQuestions(out.questions, v);
    else if (k === "terms") out.terms = patchTerms(out.terms, v);
    else out[k] = clean(v);
  }
  return out;
}

// The shape the page and SKILL.md rely on (the schema at the end of SKILL.md). Every field the
// page reads is checked for the type the render uses it as: a list it maps is an array, and text
// it shows is a string. Text goes through String() on the page, which throws on an object whose
// own toString is not a function, so "any value" is not safe there. Optional fields stay optional.
const STATUSES = ["open", "answered", "deferred", "reopened"];
const ANSWER_KINDS = ["accept", "option", "text"];
function validateState(s) {
  const need = (ok, msg) => { if (!ok) bad(msg); };
  const str = (v) => typeof v === "string";
  const strs = (v) => Array.isArray(v) && v.every(str);
  const bool = (v) => typeof v === "boolean";
  const count = (v) => Number.isInteger(v) && v >= 0;
  const check = (o, k, ok, msg) => { if (k in o) need(ok(o[k]), msg); };
  const texts = (o, keys, where) => { for (const k of keys) check(o, k, str, `${where}.${k} must be a string`); };
  const messages = (list, where) => {
    need(Array.isArray(list), `${where} must be an array`);
    list.forEach((m, i) => need(isObj(m) && (m.who === "user" || m.who === "agent") && str(m.text) && (m.at === undefined || str(m.at)),
      `${where}[${i}] must be {"who":"user"|"agent","text":"…","at":"ISO"}`));
  };
  for (const k of ["topic", "doc", "project", "created", "note"]) check(s, k, str, `${k} must be a string`);
  if ("finished" in s) {
    need(isObj(s.finished), 'finished must be an object ({"doc","visual","at"})');
    texts(s.finished, ["doc", "visual", "at"], "finished");
  }
  if ("agent" in s) {
    need(isObj(s.agent), "agent must be an object");
    check(s.agent, "status", (v) => v === "waiting" || v === "working", 'agent.status must be "waiting" or "working"');
    check(s.agent, "since", str, "agent.since must be an ISO time string");
    check(s.agent, "handled", count, "agent.handled must be a whole number (the seq of the last handled send)");
  }
  if ("terms" in s) {
    need(Array.isArray(s.terms), "terms must be an array");
    s.terms.forEach((t, i) => {
      need(isObj(t) && str(t.term), `terms[${i}] needs a string term`);
      const w = `term ${JSON.stringify(t.term)}`;
      check(t, "def", str, `${w}: def must be a string`);
      check(t, "avoid", strs, `${w}: avoid must be an array of strings`);
    });
  }
  need(Array.isArray(s.questions), "questions must be an array");
  const ids = new Set();
  s.questions.forEach((q, i) => {
    need(isObj(q) && str(q.id) && q.id !== "", `questions[${i}] needs a string id`);
    const w = q.id;
    need(!ids.has(w), `question id ${w} appears twice`); ids.add(w);
    need(Number.isFinite(q.round), `${w}.round must be a number`);
    need(str(q.title), `${w}.title must be a string`);
    need(STATUSES.includes(q.status), `${w}.status must be one of ${STATUSES.join("|")}`);
    need(isObj(q.rec), `${w}.rec must be an object ({"option","why"} or {"text","why"})`);
    texts(q.rec, ["option", "text", "why"], `${w}.rec`);
    check(q, "body", str, `${w}.body must be a string`);
    check(q, "deps", strs, `${w}.deps must be an array of question ids`);
    check(q, "options", (v) => Array.isArray(v) && v.every((x) => isObj(x) && str(x.k) && (!("text" in x) || str(x.text))),
      `${w}.options must be an array of {"k","text"} with string k and text`);
    if ("answer" in q) {
      need(isObj(q.answer) && ANSWER_KINDS.includes(q.answer.kind), `${w}.answer.kind must be one of ${ANSWER_KINDS.join("|")}`);
      texts(q.answer, ["option", "text"], `${w}.answer`);
    }
    if ("explore" in q) {
      const e = q.explore;
      need(isObj(e) && Array.isArray(e.rows), `${w}.explore must be {"at","rows":[…]}`);
      check(e, "at", str, `${w}.explore.at must be an ISO time string`);
      e.rows.forEach((r, i) => {
        const where = `${w}.explore.rows[${i}]`;
        need(isObj(r), `${where} must be {"option","pros":[…],"cons":[…]}`);
        check(r, "option", str, `${where}.option must be a string`);
        for (const k of ["pros", "cons"]) check(r, k, strs, `${where}.${k} must be an array of strings`);
      });
    }
    for (const k of ["durable", "updated"]) check(q, k, bool, `${w}.${k} must be true or false`);
    if ("thread" in q) messages(q.thread, `${w}.thread`);
  });
  if ("visual" in s) {
    const v = s.visual;
    need(isObj(v), "visual must be an object");
    check(v, "kind", (x) => x === "prototype" || x === "diagram", 'visual.kind must be "prototype" or "diagram"');
    check(v, "version", count, "visual.version must be a whole number");
    need("kind" in v && "version" in v, "visual needs kind and version; the first Visualize draw creates it (version 0)");
    check(v, "stale", bool, "visual.stale must be true or false");
    texts(v, ["note", "at"], "visual");
    check(v, "drawing", (x) => isObj(x) && (!("since" in x) || str(x.since)), 'visual.drawing must be {"since":"ISO","seq":N}');
    check(v, "queued", strs, "visual.queued must be an array of strings");
    if ("thread" in v) messages(v.thread, "visual.thread");
  }
}

function cmdPatch(o) {
  const session = mustSession(o);
  const file = path.join(session, "state.json");
  let text;
  if (o.file !== undefined) {
    if (o.file === true) die("--file needs a path");
    try { text = fs.readFileSync(path.resolve(o.file), "utf8"); } catch (e) { die(`cannot read the patch file ${o.file}: ${e.code || oneLine(e.message)}`); }
  } else {
    // tty.isatty, not process.stdin.isTTY: touching process.stdin creates a stream that makes fd 0
    // non-blocking, and the read below would then fail with EAGAIN if the patch has not arrived yet.
    if (tty.isatty(0)) die("no patch: pipe a JSON patch on stdin or pass --file <path>");
    try { text = fs.readFileSync(0, "utf8"); } catch (e) { die(`cannot read the patch from stdin: ${e.code || oneLine(e.message)}`); }
  }
  if (!text.trim()) die("empty patch: send a JSON object shaped like state.json");
  let p;
  try { p = JSON.parse(text); } catch (e) { die(`the patch is not valid JSON (state.json unchanged): ${oneLine(e.message)}`); }
  if (!fs.existsSync(file)) die(`no state.json in ${session}; \`new\` creates it`);
  let state;
  try { state = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { die(`state.json in ${session} is not valid JSON, so it was not patched: ${oneLine(e.message)}`); }
  let next;
  try { next = applyPatch(state, p, new Date().toISOString()); validateState(next); } catch (e) {
    // Every failure owes the caller one line, never a stack trace: an error the merge never
    // expected (a patch nested deep enough to overflow clean, say) reports the same way.
    die(e instanceof PatchError ? `patch rejected (state.json unchanged): ${oneLine(e.message)}`
      : `could not apply the patch (state.json unchanged): ${oneLine(e.message)}`);
  }
  let bytes;
  try { bytes = writeJson(file, next); } catch (e) { die(`could not write state.json: ${e.code || oneLine(e.message)}`, 1); }
  // One short line, never the state itself: keeping the state out of the agent's context is the point.
  const qs = next.questions;
  print({ ok: true, questions: qs.length, open: qs.filter(isOpen).length, handled: Number(next.agent && next.agent.handled) || 0, bytes });
}

const o = parseArgs(process.argv.slice(2));
({ new: cmdNew, serve: cmdServe, sessions: cmdSessions, pending: cmdPending, wait: cmdWait, url: cmdUrl, patch: cmdPatch }[o._[0]]
  || (() => die("usage: server.mjs new|serve|sessions|pending|wait|url|patch [--session DIR] ...")))(o);
