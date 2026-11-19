import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Config, Review, Run } from '../contract'
import {
  CAPS, DEFAULTS, LEAK, MOD_MARK, PROTOCOL, agentFor, applyReview, authorTextError, bufferEarly, clip, expireStale, failedReview, lensPasses, lensViews, phase, roundOf, title,
  finishSpawning, isLive, newRun, parseConfig, recordSpawn, recoverReview, reviewFrom, reviewerPrompt,
  sanitizeConfig, shouldNudge, startReview, toolConfigError, toolOffError, toolOnError, verdict,
} from './gate'
import type { LensView } from './gate'

const enabled = atom({ plugin: 'council', key: 'enabled' } as const, false)
const lockedOff = atom({ plugin: 'council', key: 'lockedOff' } as const, false)
const config = atom({ plugin: 'council', key: 'config' } as const, DEFAULTS, { shape: 'config-1' })
const run = atom({ plugin: 'council', key: 'run' } as const, null, { shape: 'run-2' })

const PANE = 'council'
const TOOL = 'mcp__council__review'
const MODE = 'mcp__council__mode'
const MAX_STOP_BLOCKS = 3
const USER_ONLY =
  'Only the user can do that: press Off in the Council band or panel, or run /council off in a terminal session.'

const openPane = ($: EngineInterface) => $.ui.open({ id: PANE, title: 'Council' })

async function setConfig($: EngineInterface, c: Config) {
  await update($, config, () => c)
  await $.store.set('config', c)
}

// byUser: a person's own action (command, band or panel button). A user Off locks the tool out of turning it back on.
async function setEnabled($: EngineInterface, on: boolean, byUser: boolean) {
  await update($, enabled, () => on)
  if (byUser) await update($, lockedOff, () => !on)
  if (!on) await update($, run, r => (r && isLive(r) ? { ...r, status: 'cancelled' as const } : r))
  $.ui.toast(on ? 'Council Mode on: your next task gets a blind review loop.' : 'Council Mode off.')
}

// The last reviewer's answer closes a round; tell the lead once.
// ponytail: two reviewers finishing in the same instant can announce twice (a duplicate message, harmless).
// Returns the run as stored after the announce, so callers see lastVerdictAt.
async function announce($: EngineInterface, r: Run | null): Promise<Run | null> {
  if (!r?.announce) return r
  const now = await $.clock.now()
  const after = await update($, run, x => (x ? { ...x, announce: false, lastVerdictAt: now } : x))
  const last = r.rounds[r.rounds.length - 1]
  if (!last) return after
  $.ui.toast(`Council round ${last.number}: ${r.status.replace(/_/g, ' ')} (worst ${last.score})`)
  await $.prompt.submit({ text: verdict(r) })
  return after
}

function summary(enabledNow: boolean, c: Config, r: Run | null) {
  const head = `Council Mode ${enabledNow ? 'ON' : 'off'} - target ${c.target}, rounds ${c.rounds}, reviewers ${c.reviewers}`
  if (!r) return head
  const scores = r.rounds.map(x => x.score).join(', ') || 'none yet'
  return `${head}\nTask: ${r.task}\nStatus: ${r.status}; round scores: ${scores}; lenses: ${r.lenses.join(', ')}`
}

// One grammar for `/council <args>` (the user) and the mode tool (the model, for desktop where mod commands don't show).
// The tool cannot cancel a live run or restart one that needs a human decision: the gated agent must not own its gate.
async function control($: EngineInterface, raw: string, fromTool: boolean, task?: string): Promise<string> {
  const arg = raw.trim()
  const c = await read($, config)
  const current = await read($, run)
  if (arg === '' || arg === 'panel') {
    await openPane($)
    return 'Council panel opened.'
  }
  if (arg === 'status') return summary(await read($, enabled), c, current)
  if (arg === 'off') {
    // The gated agent never switches its gate off, live run or not.
    if (fromTool) return `Council: ${toolOffError()} ${USER_ONLY}`
    await setEnabled($, false, true)
    return 'Council Mode off. Any running council was cancelled (not passed).'
  }
  const parsed = parseConfig(arg, c)
  if (typeof parsed === 'string') return `Council: ${parsed}`
  const turningOn = arg.split(/\s+/)[0] === 'on'
  // The tool is the gated agent: every refusal comes before any write.
  if (fromTool) {
    // A live run keeps its own settings; the tool does not touch the stored ones meanwhile either.
    const changes = parsed.target !== c.target || parsed.rounds !== c.rounds || parsed.reviewers !== c.reviewers
    if (changes && isLive(current)) return 'Council: settings cannot change while a council is running; the user can change them in the panel for the next task. Nothing changed.'
    const loosened = toolConfigError(c, parsed)
    if (loosened) return `Council: ${loosened}. Nothing changed.`
    const blocked = turningOn ? toolOnError({ run: current, lockedOff: await read($, lockedOff) }) : null
    if (blocked) return `Council: ${blocked}. Nothing changed.`
  }
  await setConfig($, parsed)
  if (!turningOn) return summary(await read($, enabled), parsed, current)
  await setEnabled($, true, !fromTool)
  // Turned on mid-turn: this prompt already passed prompt.submit, so start the run here.
  if (task?.trim() && !isLive(current)) {
    const fresh = await update($, run, () => newRun(task, parsed))
    return `${summary(true, parsed, fresh)}\n\n${PROTOCOL(fresh as Run)}`
  }
  return summary(true, parsed, await read($, run))
}

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    // autoOn (a user setting, default off): Council is on from the session's start.
    // session.start also runs on a hot reload: never override the user's own Off.
    if (options.autoOn === true && !(await read($, lockedOff))) await update($, enabled, () => true)
    const saved = await $.store.get('config')
    if (saved !== undefined) await update($, config, () => sanitizeConfig(saved))
    await $.command.register({
      name: 'council',
      description: 'Council Mode: on | off | status | panel | target N rounds N reviewers N',
      argumentHint: 'on|off|status|panel [target 8] [rounds 2] [reviewers 2]',
    })
    await $.tool.register({
      name: 'review',
      isDeferred: false,
      description:
        'Council Mode only: submit the current work for a blind review round. The Council spawns fresh reviewers that see only criteria + artifacts. End your turn after calling; the verdict arrives as a new message.',
      inputSchema: {
        type: 'object',
        properties: {
          criteria: { type: 'string', description: 'Checkable acceptance criteria for the task.' },
          artifacts: { type: 'string', description: 'File paths / diff scope the reviewers must read.' },
          checks: { type: 'array', items: { type: 'string' }, description: 'Real check results, e.g. "pytest -q: 12 passed".' },
        },
        required: ['criteria', 'artifacts'],
      },
    })
    await $.tool.register({
      name: 'mode',
      isDeferred: false,
      description:
        'Control Council Mode when the user asks (turn on, stricter settings, status, panel). args uses the /council grammar: "on [target 8] [rounds 2] [reviewers 2]", "status", "panel", or settings alone. With "on", pass the user\'s task as task to start the council now. It cannot turn Council off, loosen settings, cancel a running council, or restart one that needs a human decision: tell the user to use the panel for those.',
      inputSchema: {
        type: 'object',
        properties: {
          args: { type: 'string', description: 'e.g. "on rounds 2 reviewers 2", "off", "status", "panel".' },
          task: { type: 'string', description: 'The task to run under the council (with "on").' },
        },
        required: ['args'],
      },
    })
    return next(e)
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'council' }, async ($, e) => ({ text: await control($, e.args, false) })).catch(() => ({
    text: 'Council command failed inside the mod; see the debug log.',
  }))

  on('tool.call', { tool: MODE }, async ($, e) => {
    const input = e as unknown as { args?: string; task?: string }
    return { result: await control($, input.args ?? '', true, input.task) }
  }).catch(() => ({ deny: 'Council mode tool failed inside the mod; see the debug log.' }))

  // Mode on + a typed task -> a run starts, and every prompt of it carries the protocol.
  on('prompt.submit', async ($, e, next) => {
    // MOD_MARK opens with an invisible separator no one types, so a typed "[Council]" is still a task.
    const isOurs = e.origin.kind === 'plugin' || e.text.startsWith(MOD_MARK)
    if (e.command || e.isMeta || isOurs || !(await read($, enabled))) return next(e)
    let r = await read($, run)
    if (!isLive(r)) {
      const fresh = newRun(e.text, await read($, config))
      r = await update($, run, () => fresh)
    }
    return next({ ...e, context: [...(e.context ?? []), PROTOCOL(r as Run)] })
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: TOOL }, async ($, e) => {
    const input = e as unknown as { criteria?: string; artifacts?: string; checks?: string[] }
    const now = await $.clock.now()
    const before = await read($, run)
    if (before?.status === 'reviewing') {
      const after = await update($, run, x => (x ? expireStale(x, now) : x))
      await announce($, after)
      return {
        deny:
          after?.status === 'reviewing'
            ? 'A council round is already running; end your turn and wait for the verdict.'
            : 'The previous round timed out and was closed as invalid; its verdict was posted. Read it, then call again.',
      }
    }
    if (!before || before.status !== 'active') {
      return { deny: 'No active council. Turn it on with mcp__council__mode (args "on", task) when the user asks.' }
    }
    if (!input.criteria?.trim() || !input.artifacts?.trim()) return { deny: 'criteria and artifacts are required.' }
    if (LEAK.test(input.criteria) || LEAK.test(input.artifacts)) {
      return { deny: 'Reviewers must stay blind: remove anything naming scores, targets, thresholds or earlier rounds from criteria/artifacts.' }
    }
    const fenceError = authorTextError(input.criteria) ?? authorTextError(input.artifacts)
    if (fenceError) return { deny: `criteria/artifacts ${fenceError}.` }
    const checks = (Array.isArray(input.checks) ? input.checks : [])
      .filter(x => typeof x === 'string')
      .slice(0, CAPS.checks)
      .map(x => clip(x, CAPS.check))
    // A fresh random fence per round: author text cannot guess or forge the end marker.
    const nonce = Array.from(crypto.getRandomValues(new Uint8Array(12)), b => b.toString(16).padStart(2, '0')).join('').toUpperCase()

    // Only one call wins the active -> reviewing step.
    let won = false
    const r = await update($, run, x => {
      const started = startReview(x, checks, now)
      won = started !== null
      return started ?? x
    })
    if (!won || !r) return { deny: 'A council round is already running; end your turn and wait for the verdict.' }

    // Fresh subagents every round; ids come from the engine, not the model.
    const failed: Review[] = []
    const started = new Set<string>()
    try {
      for (const lens of r.lenses) {
        const spawned = await $.agent.spawn({
          prompt: reviewerPrompt(lens, input.criteria, input.artifacts, nonce),
          subagentType: agentFor(lens),
          description: `council ${lens} review`,
        })
        started.add(lens)
        if (spawned.deny !== undefined || !spawned.agentId) {
          failed.push(failedReview(lens, `unspawned-${lens}`, `spawn refused: ${spawned.deny ?? 'no agent id'}`))
          continue
        }
        const agentId = spawned.agentId
        await update($, run, x => (x ? recordSpawn(x, agentId, lens) : x))
      }
    } catch (err) {
      for (const lens of r.lenses) {
        if (!started.has(lens)) failed.push(failedReview(lens, `unspawned-${lens}`, `spawn failed: ${String(err).slice(0, 200)}`))
      }
    } finally {
      await announce($, await update($, run, x => (x ? finishSpawning(x, failed) : x)))
    }
    const n = r.rounds.length + 1
    return {
      result: `Council round ${n}/${r.config.rounds}: ${r.lenses.length - failed.length} fresh reviewers launched (${r.lenses.join(', ')}). End your turn now; the verdict arrives as a new message.`,
    }
  }).catch(() => ({ deny: 'Council review failed inside the mod; see the debug log.' }))

  on('turn.complete', async ($, e, next) => {
    if (e.agentId) {
      const agentId = e.agentId
      try {
        const r = await read($, run)
        const slot = r?.pending.find(p => p.agentId === agentId)
        if (slot) {
          let review: Review
          try {
            review = reviewFrom(e.answer, e.reason, slot.lens, agentId)
            if (review.error && e.reason === 'answer') {
              // The hand-back may have been refused (auto mode): look in the reviewer's own earlier messages.
              const msgs = await $.session.messages({ agentId })
              const own = Array.isArray(msgs) ? msgs.filter(m => m.role === 'assistant').map(m => m.text) : []
              review = recoverReview(e.answer, own, slot.lens, agentId)
            }
          } catch {
            review = failedReview(slot.lens, agentId, 'reviewer answer could not be read')
          }
          await announce($, await update($, run, x => (x ? applyReview(x, review) : x)))
        } else if (r?.status === 'reviewing') {
          // Ended before its spawn was recorded (or not ours): keep it for recordSpawn.
          await update($, run, x => (x ? bufferEarly(x, agentId, e.answer, e.reason) : x))
        }
      } catch {
        // ponytail: a failure here leaves the slot pending; expireStale closes the round as invalid.
      }
      return next(e)
    }
    // The gate: a main-loop answer while a council is active (no round passed, budget left)
    // queues a nudge turn. classic.Stop is not used: an org policy plugin can pass it by.
    const done = await next(e)
    try {
      const now = await $.clock.now()
      const expired = await update($, run, x => (x ? expireStale(x, now) : x))
      const r = await announce($, expired)
      const ctx = { enabled: await read($, enabled), run: r, reason: e.reason, turnStartedAt: now - e.durationMs, maxNudges: MAX_STOP_BLOCKS }
      if (!shouldNudge(ctx)) {
        if (r?.status === 'active' && r.stopBlocks >= MAX_STOP_BLOCKS && ctx.enabled) {
          $.ui.toast('Council gate stopped nudging after 3 turns with no review. The run stays unpassed.')
        }
        return done
      }
      await update($, run, x => (x ? { ...x, stopBlocks: x.stopBlocks + 1 } : x))
      await $.prompt.submit({
        text: `${MOD_MARK} COUNCIL MODE ACTIVE (${r?.rounds.length ?? 0}/${r?.config.rounds ?? 0} rounds used). Do not claim completion. Finish or fix the work, run real checks, then call ${TOOL}. If you are blocked, say what blocks you; only the user can cancel the council.`,
      })
    } catch {
      // The gate fails open on its own errors: the answer already went through.
    }
    return done
  })

  // Only the Council spawns its reviewers, so the lead cannot hand-pick or reuse one.
  on('agent.offer', ($, e, next) => (e.agent.startsWith('council:') ? { isOffered: false } : next(e))).catch(
    ($, e, next) => next(e),
  )

  // Band above the prompt: round header, then one row per lens (lowest score counts).
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || !(await read($, enabled))) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const r = await read($, run)
    const c = r?.config ?? (await read($, config))
    const p = phase(r)
    const last = r?.rounds[r.rounds.length - 1]
    const scored = last && r?.status !== 'reviewing'
    return (
      <Box flexDirection="column">
        <Box gap={1}>
          <Text color="cyan">Council</Text>
          <Text>
            Round {p.round} of {c.rounds} · {p.label}
          </Text>
          {scored ? (
            <Text color={last.passed ? 'green' : 'yellow'}>
              {last.score} / {c.target}
            </Text>
          ) : (
            <Text dimColor>Target {c.target}</Text>
          )}
          <Button key="panel" label="Details" onPress={() => void openPane($)} />
          <Button key="off" label="Off" onPress={() => setEnabled($, false, true)} />
        </Box>
        {r && lensViews(r).map(v => lensRow(Box, Text, v))}
      </Box>
    )
  }).catch(($, e, next) => next(e))

  // Footer mode label, so "on" still shows with the band collapsed.
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    if (!(await read($, enabled))) return next(e)
    const c = (await read($, run))?.config ?? (await read($, config))
    return next({ ...e, props: { ...e.props, modes: [...e.props.modes, `council · ${c.target}`] } })
  }).catch(($, e, next) => next(e))

  // Under each review call's row: who reviewed what in that round, and how it scored.
  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    if (e.props.tool !== TOOL || e.props.isRunning || e.props.isErrored) return next(e)
    const n = roundOf(e.props.output)
    const r = await read($, run)
    if (!r || n === null) return next(e)
    const closed = r.rounds.find(x => x.number === n)
    const live = !closed && r.status === 'reviewing' && n === r.rounds.length + 1
    if (!closed && !live) return next(e)
    const target = r.config.target
    const { Box, Text } = $.ui.resolve(e)
    const rows = closed
      ? closed.reviews.map(v => ({ lens: v.lens, text: `${v.score} · ${lensPasses(v, target) ? 'at target' : `below ${target}`}`, color: lensPasses(v, target) ? 'green' : 'yellow' }))
      : lensViews(r).map(v => ({ lens: v.lens, text: v.score === undefined ? 'Working' : `${v.score}`, color: v.score === undefined ? 'magenta' : v.state === 'pass' ? 'green' : 'yellow' }))
    const row = await next(e)
    return (
      <Box flexDirection="column">
        {row}
        {rows.map(x => (
          <Box key={`rev-${n}-${x.lens}`} justifyContent="space-between">
            <Text>
              <Text dimColor>Reviewed </Text>
              <Text bold>{title(x.lens)}</Text>
              <Text dimColor> · round {n}</Text>
            </Text>
            <Text color={x.color}>{x.text}</Text>
          </Box>
        ))}
      </Box>
    )
  }).catch(($, e, next) => next(e))

  // Pane: settings as segmented buttons, then the run's rounds and each reviewer's findings.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const isOn = await read($, enabled)
    const c = await read($, config)
    const r = await read($, run)
    const seg = (key: keyof Config, name: string, values: number[]) => (
      <Box key={`seg-${key}`} flexDirection="column">
        <Text dimColor>{name}</Text>
        <Box gap={1}>
          {values.map(v => (
            <Button
              key={`${key}-${v}`}
              label={String(v)}
              variant={c[key] === v ? 'primary' : 'secondary'}
              onPress={() => setConfig($, { ...c, [key]: v })}
            />
          ))}
        </Box>
      </Box>
    )
    const p = phase(r)
    return (
      <Box flexDirection="column" gap={1}>
        <Box justifyContent="space-between">
          <Text bold>Council {isOn ? 'on' : 'off'}</Text>
          <Button key="toggle" label={isOn ? 'Turn off' : 'Turn on'} variant={isOn ? 'secondary' : 'primary'} onPress={() => setEnabled($, !isOn, true)} />
        </Box>
        <Text dimColor>Reviewers score the work until all reach your target. Lowest score counts; critical/high findings block. Settings apply to the next task.</Text>
        {seg('target', 'Target score', [7, 8, 8.5, 9, 9.5, 10])}
        {seg('rounds', 'Max rounds', [1, 2, 3, 5, 10])}
        {seg('reviewers', 'Reviewers', [2, 3, 4, 5])}
        {!r && <Text dimColor>No council run yet. Turn it on, then type a task.</Text>}
        {r && (
          <Box flexDirection="column">
            <Text>Task: {clip(r.task, 200)}</Text>
            <Text dimColor>
              Round {p.round} of {r.config.rounds} · {p.label} · target {r.config.target}
            </Text>
            {r.rounds.map(x => (
              <Text key={`round-${x.number}`} color={x.passed ? 'green' : 'yellow'}>
                Round {x.number}: {x.score} / {r.config.target}, {x.blockers} blocking{x.passed ? ' · passed' : ''}
              </Text>
            ))}
            {lensViews(r).map(v => (
              <Box key={`detail-${v.lens}`} flexDirection="column" marginTop={1}>
                {lensRow(Box, Text, v)}
                {v.review?.error && <Text color="red">{'  '}invalid: {clip(v.review.error, 120)}</Text>}
                {v.review?.recovered && <Text dimColor>{'  '}recovered from an earlier reviewer message</Text>}
                {v.review?.findings.map((f, i) => (
                  <Text key={`f-${v.lens}-${i}`} color={f.severity === 'critical' || f.severity === 'high' ? 'red' : undefined}>
                    {'  '}[{f.severity}] {clip(f.location, 160)}: {clip(f.evidence)}
                  </Text>
                ))}
                {v.review && v.review.limitations.length > 0 && <Text dimColor>{'  '}limits: {clip(v.review.limitations.join('; '))}</Text>}
              </Box>
            ))}
          </Box>
        )}
      </Box>
    )
  }).catch(($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text dimColor>Council panel failed to draw; see the debug log.</Text>
  })
}

const MARK = {
  pass: { icon: '✓', color: 'green' },
  fail: { icon: '!', color: 'yellow' },
  reviewing: { icon: '•', color: 'magenta' },
  waiting: { icon: '·', color: undefined },
} as const

// ponytail: Box/Text passed in, not a component: each surface resolves its own element table.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function lensRow(Box: any, Text: any, v: LensView) {
  const m = MARK[v.state]
  const right = v.score === undefined ? title(v.state) : `${v.score}${v.blockers ? ` · ${v.blockers} blocking` : ''}`
  return (
    <Box key={`lens-${v.lens}`} justifyContent="space-between">
      <Text>
        <Text color={m.color}>{m.icon} </Text>
        <Text color={v.state === 'fail' ? 'yellow' : undefined}>{title(v.lens)}</Text>
      </Text>
      <Text color={v.state === 'fail' ? 'yellow' : undefined} dimColor={v.state !== 'fail'}>
        {right}
      </Text>
    </Box>
  )
}
