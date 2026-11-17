# Council Mode (Claude Code mod) v0.6

Toggle-able quality gate: Claude plans, implements, then a council of fresh, blind reviewer subagents scores the work. Lowest score decides, critical/high findings block, rounds are bounded, and an exhausted budget hands the decision back to you.

Inspired by the Council workflow shown in https://youtu.be/-0sRekR9sZ4. Independent implementation; not affiliated with Anthropic or PandaCode. Uses the early-access Claude Code mods API (function hooks), which may change between releases.

## Install

Full steps (local clone, check, update, remove): [INSTALL.md](INSTALL.md).

At the prompt of a terminal session:

```
/plugin install council --marketplace itumor/claude-council-mode
```

From a shell:

```bash
claude plugin install council --marketplace itumor/claude-council-mode
```

Desktop app: click + next to the prompt box, Plugins, Add marketplace `itumor/claude-council-mode`, then Add plugin.

## Use

Terminal:

```
/council on                       # mode on; your next prompt is the task
/council on target 8 rounds 3 reviewers 2
/council                          # open the panel (toggle, settings, scores, findings)
/council status
/council off                      # cancels a running council (not passed)
```

Desktop app (mod slash commands don't show there): just ask, e.g. `Council on. Task: ...`, `council panel`, `council status`. Claude drives the same grammar through the `mcp__council__mode` tool, which may only make settings stricter: lower the target, cut reviewers or add rounds in the panel yourself.

While a run is live, a new prompt continues it rather than starting a new task: press Off first to start fresh.

**Always on:** the `autoOn` setting (default off) turns Council on at the start of every session. Set it on the install screen, or later in the config menu (`/config`, the council row). Every task then gets the review loop, so expect much higher token use. Off in the band or panel still switches it off for that session, and a reload does not switch it back on.

UI while on: band above the prompt (`Round N of M · reviewing|fixing`, lowest score vs target, one row per lens with its score), footer label `council · <target>`, per-lens results under each review call, and a panel with segmented target/rounds/reviewers buttons plus each reviewer's findings.

## How it works

| Piece | Mechanism |
|---|---|
| Protocol | `prompt.submit` adds the council rules to every prompt of a live run |
| Review round | Claude calls `mcp__council__review {criteria, artifacts, checks}`; the **mod** spawns one fresh reviewer per lens (`council:reviewer-*`) |
| Blindness | Reviewer prompt holds only criteria + artifacts + lens, each inside a random per-round fence; text naming targets/rounds/scores or fence markers is refused, and both fields are capped |
| Identity | Reviewer ids are engine agent ids; lens set by the mod; every lens yields exactly one review (an unrecorded one counts as invalid); reviewers are left out of the agent list Claude sees (`agent.offer`), and an agent Claude starts by name is never counted, since only ids the mod got from its own spawn are recorded |
| Scoring | Answers collected on `turn.complete`; malformed JSON = score 0; min score, blockers, budget -> `passed` / `active` / `needs_human_decision`. When a reviewer's final message holds no review (its hand-back was refused, as auto mode can do), the newest earlier message of that reviewer that is a bare review JSON (no surrounding prose) is used and flagged `recovered` by the mod; tool output is never searched. The final answer itself is read more leniently (the JSON object inside it), since it is the reviewer's own hand-back |
| Verdict | Posted back as a new message (`$.prompt.submit`) so the loop continues; reviewer text inside it is fenced, clipped and capped |
| Gate | after a main-loop answer while the mode is on and a run is active, `turn.complete` queues a nudge turn (max 3 without a review, none in a turn that got a verdict; run stays unpassed). Not `classic.Stop`: an org policy plugin can pass it by |

Lenses (first N): security, correctness, reliability, maintainability, performance. Settings persist in `$.store`; a running council keeps the settings it started with, and the mode tool cannot change settings while one runs.

Who controls the gate: through the mode tool Claude can turn the mode on, make settings stricter, read status and open the panel. It cannot turn the mode off, loosen settings, cancel a running council, restart one that needs a human decision, or turn the mode back on after you turned it off. After a run passed, it can start the next one when you ask for a new task in chat (that is how the desktop app turns Council on). Only you can (panel buttons, Off in the band, `/council`, or typing a new task).

## Limits

- Reviewers are read-only (Read/Grep/Glob): test results come from Claude's `checks`. Reviewers treat them as reported evidence (no score penalty for being unable to run them) and cap at 8 only for claims they could check by reading files but could not confirm. A Claude that lies about checks is not caught by this; CI is.
- Claude writes the criteria and artifact list reviewers start from. They are fenced as unverified author claims and a guard refuses text naming scores, targets or earlier rounds, but Claude can still frame the review. Reviewers read the files themselves.
- The guard that keeps scores, targets and round history out of reviewer prompts is a best-effort pattern check (it catches `target 9`, `9/10`, `score of 8`, but not every phrasing, such as `nine out of ten`).
- Reviewers can read any file their tools reach, not only the listed artifacts, and the files they read can try to steer them. Reviewers are told to report any text aimed at them as a high finding, which blocks the round, but that rests on the reviewer model noticing it. Keep secrets out of reach of the session.
- **A passing council is not proof.** Claude writes the code and controls the repository the reviewers read, so a pass means independent reviewers found no blocking issue, not that none exists. Real CI and human review remain the gate for anything that ships.
- Reviewer findings are untrusted text; the verdict passes them back fenced and clipped as data, but it still arrives as a user-role message, the only way a mod can start Claude's next turn.
- A round whose reviewers never report closes as invalid after 20 minutes (checked on Claude's next turn or review call).
- Background reviewers also report straight into the conversation, as all background agents do; the mod's own verdict is the one that counts.
- Same model family reviews its own family's work; correlated misses are possible.
- Not a substitute for CI or human review.

## Develop

`claude plugin test .` runs `hooks/gate.test.ts` and `hooks/ui.test.tsx`. Type-check with `npx tsc -p .` after the mod has loaded once: the engine writes this build's API types into `.claude-plugin/types/` (gitignored, regenerated per Claude Code version).

Files: `hooks/register.tsx` (hooks + UI), `hooks/gate.ts` (pure scoring logic), `hooks/gate.test.ts`, `agents/` (reviewers), `types/` (state contract).
