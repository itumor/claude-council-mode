# Council Mode (Claude Code mod) v0.3

Toggle-able quality gate: Claude plans, implements, then a council of fresh, blind reviewer subagents scores the work. Lowest score decides, critical/high findings block, rounds are bounded, and an exhausted budget hands the decision back to you.

Inspired by the Council workflow shown in https://youtu.be/-0sRekR9sZ4. Independent implementation; not affiliated with Anthropic or PandaCode. Uses the early-access Claude Code mods API (function hooks), which may change between releases.

## Install

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

Desktop app (mod slash commands don't show there): just ask, e.g. `Council on, rounds 2 reviewers 2. Task: ...`, `council panel`, `council off`. Claude drives the same grammar through the `mcp__council__mode` tool.

Band above the prompt while on: status, round, worst score vs target, Panel / Off buttons.

## How it works

| Piece | Mechanism |
|---|---|
| Protocol | `prompt.submit` adds the council rules to every prompt of a live run |
| Review round | Claude calls `mcp__council__review {criteria, artifacts, checks}`; the **mod** spawns one fresh reviewer per lens (`council:reviewer-*`) |
| Blindness | Reviewer prompt holds only criteria + artifacts + lens; text naming targets/rounds/scores is refused |
| Identity | Reviewer ids are engine agent ids; lens set by the mod; reviewers hidden from Claude's Agent tool (`agent.offer`) |
| Scoring | Answers collected on `turn.complete`; malformed JSON = score 0; min score, blockers, budget -> `passed` / `active` / `needs_human_decision` |
| Verdict | Posted back as a new message (`$.prompt.submit`) so the loop continues |
| Gate | after a main-loop answer while a run is active, `turn.complete` queues a nudge turn (max 3 without a review; run stays unpassed). Not `classic.Stop`: an org policy plugin can pass it by |

Lenses (first N): security, correctness, reliability, maintainability, performance. Settings persist in `$.store`; a running council keeps the settings it started with.

Who controls the gate: Claude can turn the mode on, change settings and read status through the mode tool, but cannot cancel a running council or restart one that needs a human decision. Only you can (Off button in the band or panel, `/council off`, or typing a new task).

## Limits

- Reviewers are read-only (Read/Grep/Glob): test results come from Claude's `checks`, recorded as claims.
- Claude writes the criteria and artifact list reviewers start from. They are fenced as unverified author claims and a guard refuses text naming scores, targets or earlier rounds, but Claude can still frame the review. Reviewers read the files themselves.
- Reviewer findings are untrusted text (reviewers read untrusted files); the verdict passes them back fenced and clipped as data.
- A round whose reviewers never report closes as invalid after 20 minutes (checked on Claude's next turn or review call).
- Background reviewers also report straight into the conversation, as all background agents do; the mod's own verdict is the one that counts.
- Same model family reviews its own family's work; correlated misses are possible.
- Not a substitute for CI or human review.

## Develop

`claude plugin test .` runs `hooks/gate.test.ts`. Type-check with `npx tsc -p .` after the mod has loaded once: the engine writes this build's API types into `.claude-plugin/types/` (gitignored, regenerated per Claude Code version).

Files: `hooks/register.tsx` (hooks + UI), `hooks/gate.ts` (pure scoring logic), `hooks/gate.test.ts`, `agents/` (reviewers), `types/` (state contract).
