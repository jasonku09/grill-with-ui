# Visualize — design (decided 2026-09-06)

A **Visualize** button in the grill page's header turns the grill so far into one artifact
the user can look at: an interactive HTML prototype when the topic is a UI, an architecture
or flow diagram otherwise. Clicking it flips the area under the header to a visualize page
that shows the artifact with its own feedback thread beside it. Ordinary decisions mark an
affected visual out of date; redraws happen on explicit requests and at final reconciliation.
Grilled on
the grill-with-ui page itself on 2026-09-06 (8 questions, 2 of them durable), all
recommendations accepted.

## Terms

- **Visual**: the one artifact the Visualize button produces for a grill, a prototype or a
  diagram, regenerated on request. _Avoid_: mockup, preview.
- **Prototype**: a self-contained interactive HTML page standing in for the UI being
  grilled. _Avoid_: wireframe, demo.
- **Diagram**: an architecture or flow picture for a non-UI grill. _Avoid_: chart, graph.
- **Version**: one regeneration of the visual; numbered from 1, each with a one-line change
  note. _Avoid_: revision, draft.
- **Feedback**: a message in the visual's own thread, about the visual. _Avoid_: comment,
  review.
- **Assumed region**: a part of the visual drawn from a recommendation whose question is
  still open, marked as such. _Avoid_: placeholder.

## Why

In the user's words: "A 'Visualize' button at the top bar. This either generates an
interactive prototype (pure html) if it's a UI grill session or an architecture / flow
diagram if it's a non-UI grill. Clicking it will flip the main section (everything
underneath header) to the new visualize page. User should also be able to provide feedback
on the page, specific to the visual. Agent should be instructed to auto-update after each
turn (if needed) if the user has clicked it once."

A grill produces decisions as text. Seeing them drawn, with the undecided parts marked,
makes the next decision easier and gives feedback something concrete to point at.

The original request above included automatic updates. Jason superseded that choice while
using the Altitude grill on 2026-09-06: the next round appeared while the previous answer
still showed "sent", because the agent delayed its acknowledgement until the visual draw
finished. He requested that visualization stop auto-regenerating each turn.

## Locked decisions (don't re-litigate)

1. **One mechanism: a self-contained HTML file, shown in a sandboxed iframe** (Q1). The
   agent writes one HTML file per session; a prototype is HTML/CSS/JS, a diagram is inline
   SVG or HTML boxes with SVG arrows. The page never loads a rendering library. Zero
   dependencies, works offline, keeps the skill's "one script, one page" promise to
   adopters. The agent may itself embed Mermaid from a CDN inside its own file when a
   diagram outgrows hand layout (roughly fifteen nodes), with a one-line note in the file
   that it needs network. Rejected: Mermaid loaded by the page from a CDN (network
   dependency in the page, two mechanisms); a bundled renderer (~2 MB carried by every
   adopter whether they draw diagrams or not).

2. **Questions are the source of truth; the visual is derived** (Q8). Feedback on the
   visual is applied to the visual as asked. If it contradicts an answered question, the
   agent reopens that question with the feedback quoted in its thread and the
   recommendation rewritten (marked "updated"). The recorded answer changes only when the
   user answers the question again. Rejected: silently changing the answer to match the
   feedback (a locked decision overturned by a remark about a picture, no trail, wrong-
   question risk); leaving the visual free to drift from the record (the design doc and the
   shipped visual could contradict each other at Finish). Reversing this later would change
   how Finish and resume work, which is why it is durable.

## Routine choices

- **Feedback flow** (Q2): the first Visualize click fires immediately, like Explore deeper
  (it is a generate request). Feedback notes are staged like discussion messages and ship
  with the next Send, several at once. Rejected: every note immediate (a full agent turn per
  sentence, interleaves with rounds); everything staged (a dead-feeling button).
- **Visualize page layout** (Q3): the visual fills the list and card columns (about two
  thirds of the width). The right panel becomes the visual's discussion: its feedback
  thread plus a composer. The header button toggles between Visualize and Questions. The
  footer stays, so Send works from the visualize page too.
- **Who classifies** (Q4): the agent decides prototype vs diagram from the topic and the
  questions so far, labels the visualize page accordingly, and switches when feedback says
  so ("make this a diagram"). Two buttons and a terminal question were rejected as chores
  for the rare ambiguous case.
- **Requested updates** (supersedes Q5, Jason's 2026-09-06 direction): ordinary answers,
  reopens, and recommendation changes set `visual.stale = true` when they affect the
  visual; they do not draw or bump its version. The page says Out of date and offers
  Regenerate. Visualize, Regenerate, and explicit visual-feedback sends request a draw;
  Finish reconciles once before export. A requested redraw includes all accumulated
  decisions, then clears `stale`, bumps the version, and records its change note.
  Rejected: automatic redraws between rounds (delay and misleading pending indicators),
  silently presenting an old visual as current. Answers, the next round, and
  `agent.handled` are published together so a completed send clears immediately.
- **Finish** (Q6): Finish copies the final visual next to the design doc as
  `docs/<slug>-visual.html` and links it from the doc's summary. Rejected: leaving it in the
  session folder under the home directory; embedding the source in the doc.
- **Undecided parts** (Q7): the visual draws the recommended option for every open question
  and marks those regions "assumed · Qn open" (dashed outline or tag). Decided parts are
  drawn plain. Rejected: leaving undecided regions empty (prototype unusable until the end);
  drawing guesses unmarked (a finished-looking picture gets treated as decided).
- **Where the file lives and how it reaches the page** (stated as routine engineering in
  Q6's body): `<session>/visual.html`, written only by the agent, served by the session
  server at `/visual`, shown in an iframe with `sandbox="allow-scripts"` and no same-origin
  (a prototype cannot read the page's storage or post to `/send`). The page reloads the
  iframe when `visual.version` changes.

- **Who draws the file**: see [Subagent or inline](../SKILL.md#subagent-or-inline) for
  mode selection and execution. The user-facing toggle is described in [Use](../README.md#use).
- **Prototype context**: see the [visual brief](../visual-brief.md#the-file) for the
  fidelity rules for existing apps and new UI.
- **Background draws**: the draw lifecycle and handling of queued requests are defined in
  [Visualize](../SKILL.md#visualize).

## Verified facts

- Explore deeper already fires on click and shows an in-flight state until
  `agent.handled` catches up; the first Visualize click reuses that pattern.
- Staged discussion messages already persist in `localStorage` and survive a reload; the
  feedback thread reuses that machinery with the visual as its subject.

## Risks

- **Diagram quality.** Hand-authored SVG layouts degrade past roughly fifteen nodes.
  Mitigation: the agent may embed Mermaid from a CDN inside its own file, with a note.
- **Missed contradictions.** If the agent fails to spot that feedback contradicts an
  answered question, the visual and the record disagree until Finish. Mitigation: the
  Finish step reconciles the visual against every answered question before copying it.
- **Regeneration cost and delayed acknowledgement.** Redraws can take longer than an
  interview response. Mitigation: explicit redraws, an Out of date indicator between
  draws, and publishing the next round with its send acknowledgement in one update.
- **Sandbox surprises.** The iframe has no network and no same-origin access, so a
  prototype that tries to fetch anything fails silently. Intended; the agent's guidance
  says so.

## Deferred

- Two visuals for one grill (a prototype and a diagram side by side), Q4's rejected
  option B, as a later addition.
- Version history on the visualize page (looking at earlier versions). Only the latest is
  kept in v1; versions are numbered so history can be added without a schema change.

## Open threads

- None. Pros-and-cons tables were requested for Q2 and Q8 and informed the accepted
  answers; no discussion ended without a decision.

## State and event additions (for the build)

See the [state and event reference](../SKILL.md#statejson) and
[Subagent or inline](../SKILL.md#subagent-or-inline) for draw-request handling.
