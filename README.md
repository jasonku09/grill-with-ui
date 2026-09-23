# grill-with-ui

A skill for coding agents that moves a "grilling" design interview out of the terminal and
onto a local browser page. The agent asks its questions as cards, each with lettered options
and a highlighted recommendation. You answer them in any order, defer or reopen them, discuss
any single one in its own thread without losing the rest of the session, and press one
button, **Send to Agent**, to ship everything you staged as a single turn. At the end the
agent writes an exhaustive design doc for the topic.

![A grill in progress: the recommended option accepted on one question, a question asked in
another one's discussion thread, both shipped with one Send, the agent's reply and next round
of questions arriving, a pros and cons table from Explore deeper, a prototype of the design
from Visualize, and that prototype redrawn after one note of feedback](docs/demo.gif)

Above: a recommendation accepted on Q3 and a question asked on Q4 go to the agent as one Send,
and its reply opens the next round. Then one click on **Explore deeper** lays out the pros and
cons of Q6's options, **Visualize** draws the design so far as a prototype, and one note in its
feedback thread redraws it as v2 with the change asked for. Recorded against a real session by
[`design/record-demo.mjs`](design/record-demo.mjs).

Under the hood it is small on purpose: one Node script and one HTML file, no dependencies,
no build step. The agent owns `state.json` and changes it only through
`node server.mjs patch`, sending just what changed as a small JSON patch that the script
merges, validates, and writes atomically; a whole-file rewrite would put the entire state
(60 KB by the end of a long grill) into the agent's context on every turn. The page appends
one line per Send to `events.jsonl`; the server that serves the page is also the process
whose output a persistent Monitor delivers to the agent. In wait mode the agent must keep
its foreground listener active; a page server alone cannot wake an ended agent turn.
Submissions made while the agent is not listening remain queued for resume.

## Install

The skill is a plain [Agent Skills](https://agentskills.io) folder (`SKILL.md` plus one
script and one page), so it installs the same way everywhere: put this folder where your
agent looks for skills, under the name `grill-with-ui`. A symlink keeps `git pull` as the
update path; copying the folder works too. Node 20 or newer is the only requirement.

```sh
git clone https://github.com/jasonku09/grill-with-ui ~/Projects/grill-with-ui
ln -s ~/Projects/grill-with-ui ~/.claude/skills/grill-with-ui   # Claude Code (Cursor reads it too)
ln -s ~/Projects/grill-with-ui ~/.agents/skills/grill-with-ui   # Codex, Gemini CLI, Cursor, Copilot
```

Where each agent looks, and how to start a grill once it is there:

| Agent | User-level folder | Project-level folder | Start a grill |
|---|---|---|---|
| Claude Code | `~/.claude/skills/` | `.claude/skills/` | `/grill-with-ui <topic>` |
| Codex (CLI, IDE) | `~/.agents/skills/` | `.agents/skills/` | `$grill-with-ui <topic>` |
| Gemini CLI | `~/.gemini/skills/` or `~/.agents/skills/` | `.gemini/skills/` or `.agents/skills/` | say "grill with ui: <topic>"; accept the activation prompt |
| Cursor | `~/.cursor/skills/` or `~/.agents/skills/` (also `~/.claude/skills/`) | `.cursor/skills/` or `.agents/skills/` | `/grill-with-ui <topic>` in Agent chat |
| GitHub Copilot (CLI, VS Code, JetBrains) | `~/.copilot/skills/` or `~/.agents/skills/` | `.github/skills/`, `.claude/skills/`, or `.agents/skills/` | say "grill with ui: <topic>" |
| Any other agent that reads `SKILL.md` | its skills folder | | say "grill with ui: <topic>" |

Paths are from each product's documentation as of September 2026; `/skills` (Codex,
Gemini CLI) or the agent's skill picker will show whether the install landed. The skill's
description names the phrase "grill with ui", so plain language works on every agent.

What the agent needs at run time:

- **A shell tool and Node 20+.** Claude Code is woken per Send by its persistent Monitor
  tool. Every other agent uses **wait mode**, spelled out in `SKILL.md`: it starts the
  server detached (or in a harness-managed shell session) and keeps `node server.mjs wait`
  active in the foreground. It returns on the next Send or after a bounded timeout, then
  loops. The agent keeps listening after replies and completed visuals, until the user
  finishes or explicitly pauses; a running server is not a substitute for that listener.
- **Optionally a subagent tool**, for Visualize. With one, the visual is drawn in the
  background while you keep answering. Without one, the agent draws it inline and that
  turn takes longer.

## Use

In any project:

```
/grill-with-ui <topic you want grilled>
```

The agent prints a URL. Open it. Answer by clicking an option (the recommended one is
outlined) or writing free text; start a discussion in the right-hand panel; use **Defer** and **Reopen** on a card when
you want to. Everything you do is staged (and survives a reload) until you press **Send N to
Agent** (⌘↩). The one exception is **Explore deeper** next to a question's title: it goes to
the agent the moment you click it, and the pros and cons table for that question's options
appears in the discussion panel when the agent is done. The agent answers
threads, writes the tables, records your answers, and adds the next round of questions to
the page.

**Visualize** in the header asks the agent for one picture of the design so far: an
interactive HTML prototype when the topic is a UI, an architecture or flow diagram
otherwise. When the topic is a change to an existing app, the prototype is drawn inside the
real page it changes, with the app's own look. It appears in place of the question list and
card, with its own feedback thread on the right. Undecided parts are drawn from the
recommendations and marked "assumed"; feedback you add there ships with your next Send and
redraws it; a note that contradicts an answered question reopens that question rather than
silently changing your answer. Ordinary answers and question discussions do not regenerate
the visual or delay the next round. When decisions change what it shows, it is marked
**Out of date**; click **Regenerate** to include the latest decisions. Each requested redraw
has a version number and a one-line change note. The agent never writes the file in the
grill conversation itself: it briefs a subagent (rules in `visual-brief.md`) so hundreds of
lines of markup stay out of the interview's context. The draw runs in the background, so
Send keeps working and the interview goes on while it is drawn; the header says
Visualizing… (or the strip says regenerating…) until the new version lands. Finish
reconciles and copies the final visual next to the design doc as
`docs/<topic>-visual.html`.

**Finish grill** sends at once (after an inline confirm), together with anything you had
staged; the agent writes the design doc to the path shown in the header (default
`docs/<topic>-design.md` in your project) and stops.

To pick up an unfinished grill, in the same project:

```
/grill-with-ui resume
```

If the agent crashed or was closed, sends you made in the meantime are replayed on resume,
and the page tab you still have open reconnects on its own.

## Files

Session state lives outside your repo, so there is nothing to gitignore:

```
~/.grill-with-ui/
  ui.json        global UI prefs shared by every grill (theme)
  sessions/<project-key>/<YYYYMMDD-HHMMSS>/
    state.json     written only by the agent, through `patch` (questions, recommendations, threads, status)
    events.jsonl   appended only by the page, one line per Send
    server.json    url, port and pid of the running server
    visual.html    the prototype or diagram, drawn by the agent's subagent, served at /visual
```

`<project-key>` is the git common root of the project with slashes turned into dashes, so
every worktree of a repo sees the same sessions; outside git it is the working directory.

In this repo: `server.mjs` (the server and CLI), `page.html` (the page), `SKILL.md` (the
prompt the agent follows), `test/`, and `design/` + `docs/design.md` (how it was designed).
`design/record-demo.mjs` re-records the GIF above by driving the real page; it needs
Playwright and `ffmpeg`.

## Server commands

```
node server.mjs new      --topic T [--doc P]                  create a session, print its folder
node server.mjs serve    --session DIR [--port N]             serve the page; print one line per Send
node server.mjs sessions [--all]                               list this project's sessions
node server.mjs pending  --session DIR                         print sends past agent.handled
node server.mjs wait     --session DIR [--after N] [--timeout S]  block until the next send (exit 3 on timeout)
node server.mjs url      --session DIR [--timeout S]           print the running server's url
node server.mjs patch    --session DIR [--file P]              apply a JSON patch (stdin or P) to state.json
```

`patch` merges by the rules in `SKILL.md` ("Patching state.json"). A bad patch exits
non-zero and leaves the file untouched; a good one prints one short summary line, never the
state.

`GRILL_HOME` overrides `~/.grill-with-ui`.

## Tests

```sh
node --test test/server.test.mjs
PLAYWRIGHT_PKG=/path/to/node_modules/@playwright/test/index.mjs node test/page.e2e.mjs
```

The page check needs Playwright with Chromium; point `PLAYWRIGHT_PKG` at an existing install
or run it with `@playwright/test` installed next to the repo. It starts a real server on a
throwaway session and drives the page end to end (staging, reload, send, working state,
server restart, finished state).
