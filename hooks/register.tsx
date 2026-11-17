import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Config, Review, Run } from '../types'
import {
  DEFAULTS, LEAK, PROTOCOL, agentFor, applyReview, bufferEarly, expireStale, failedReview,
  finishSpawning, isLive, newRun, parseConfig, recordSpawn, reviewFrom, reviewerPrompt,
  sanitizeConfig, startReview, verdict,
} from './gate'

const enabled = atom({ plugin: 'council', key: 'enabled' } as const, false)
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

async function setEnabled($: EngineInterface, on: boolean) {
  await update($, enabled, () => on)
  if (!on) await update($, run, r => (r && isLive(r) ? { ...r, status: 'cancelled' as const } : r))
  $.ui.toast(on ? 'Council Mode on: your next task gets a blind review loop.' : 'Council Mode off.')
}

// The last reviewer's answer closes a round; tell the lead once.
// ponytail: two reviewers finishing in the same instant can announce twice (a duplicate message, harmless).
async function announce($: EngineInterface, r: Run | null) {
  if (!r?.announce) return
  await update($, run, x => (x ? { ...x, announce: false } : x))
  const last = r.rounds[r.rounds.length - 1]
  if (!last) return
  $.ui.toast(`Council round ${last.number}: ${r.status.replace(/_/g, ' ')} (worst ${last.score})`)
  await $.prompt.submit({ text: verdict(r) })
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
    if (fromTool && isLive(current)) return `A council is running. ${USER_ONLY}`
    await setEnabled($, false)
    return 'Council Mode off. Any running council was cancelled (not passed).'
  }
  const parsed = parseConfig(arg, c)
  if (typeof parsed === 'string') return `Council: ${parsed}`
  await setConfig($, parsed)
  if (arg.split(/\s+/)[0] !== 'on') return summary(await read($, enabled), parsed, current)
  if (fromTool && current?.status === 'needs_human_decision') {
    return `The last council needs a human decision (round budget spent). A new run must come from the user typing the task. Settings saved.`
  }
  await setEnabled($, true)
  // Turned on mid-turn: this prompt already passed prompt.submit, so start the run here.
  if (task?.trim() && !isLive(current)) {
    const fresh = await update($, run, () => newRun(task, parsed))
    return `${summary(true, parsed, fresh)}\n\n${PROTOCOL(fresh as Run)}`
  }
  return summary(true, parsed, await read($, run))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const saved = await $.store.get('config')
    if (saved !== undefined) await update($, config, () => sanitizeConfig(saved))
    await $.command.register({
      name: 'council',
      description: 'Council Mode: on | off | status | panel | target N rounds N reviewers N',
      argumentHint: 'on|off|status|panel [target 9] [rounds 5] [reviewers 3]',
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
        'Control Council Mode when the user asks (turn on, settings, status, panel, off between tasks). args uses the /council grammar: "on [target 9] [rounds 5] [reviewers 3]", "off", "status", "panel", or settings alone. With "on", pass the user\'s task as task to start the council now. It cannot cancel a running council or restart one that needs a human decision.',
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
    const isOurs = e.origin.kind === 'plugin' || e.text.startsWith('[Council]')
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
    const checks = (input.checks ?? []).filter(x => typeof x === 'string')

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
          prompt: reviewerPrompt(lens, input.criteria, input.artifacts),
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
      const r = await read($, run)
      const slot = r?.pending.find(p => p.agentId === agentId)
      if (slot) {
        let review: Review
        try {
          review = reviewFrom(e.answer, e.reason, slot.lens, agentId)
        } catch {
          review = failedReview(slot.lens, agentId, 'reviewer answer could not be read')
        }
        await announce($, await update($, run, x => (x ? applyReview(x, review) : x)))
      } else if (r?.status === 'reviewing') {
        // Ended before its spawn was recorded (or not ours): keep it for recordSpawn.
        await update($, run, x => (x ? bufferEarly(x, agentId, e.answer, e.reason) : x))
      }
      return next(e)
    }
    // The gate: a main-loop answer while a council is active (no round passed, budget left)
    // queues a nudge turn. classic.Stop is not used: an org policy plugin can pass it by.
    const done = await next(e)
    const now = await $.clock.now()
    const r = await update($, run, x => (x ? expireStale(x, now) : x))
    await announce($, r)
    if (e.reason !== 'answer' || !r || r.status !== 'active') return done
    if (r.stopBlocks >= MAX_STOP_BLOCKS) {
      $.ui.toast('Council gate stopped nudging after 3 turns with no review. The run stays unpassed.')
      return done
    }
    await update($, run, x => (x ? { ...x, stopBlocks: x.stopBlocks + 1 } : x))
    await $.prompt.submit({
      text: `[Council] COUNCIL MODE ACTIVE (${r.rounds.length}/${r.config.rounds} rounds used). Do not claim completion. Finish or fix the work, run real checks, then call ${TOOL}. If you are blocked, say what blocks you; only the user can cancel the council.`,
    })
    return done
  }).catch(($, e, next) => (next.called ? { text: e.answer } : next(e)))

  // Only the Council spawns its reviewers, so the lead cannot hand-pick or reuse one.
  on('agent.offer', ($, e, next) => (e.agent.startsWith('council:') ? { isOffered: false } : next(e))).catch(
    ($, e, next) => next(e),
  )

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || !(await read($, enabled))) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const r = await read($, run)
    const c = r?.config ?? (await read($, config))
    const last = r?.rounds[r.rounds.length - 1]
    const state = !r
      ? 'waiting for a task'
      : r.status === 'reviewing'
        ? `reviewing ${r.partial.length}/${r.lenses.length}`
        : r.status.replace(/_/g, ' ')
    return (
      <Box>
        <Text color="cyan">Council </Text>
        <Text>
          {state} · round {r?.rounds.length ?? 0}/{c.rounds} · worst {last ? last.score : '-'} / {c.target}{' '}
        </Text>
        <Button key="panel" label="Panel" onPress={() => void openPane($)} />
        <Button key="off" label="Off" onPress={() => setEnabled($, false)} />
      </Box>
    )
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Select, Progress } = $.ui.resolve(e)
    const isOn = await read($, enabled)
    const c = await read($, config)
    const r = await read($, run)
    const pick = (key: keyof Config, values: number[]) => (
      <Select
        key={key}
        label={`${key}: `}
        value={String(c[key])}
        options={values.map(v => ({ value: String(v), label: String(v) }))}
        onSelect={v => setConfig($, { ...c, [key]: Number(v) })}
      />
    )
    const last = r?.rounds[r.rounds.length - 1]
    return (
      <Box flexDirection="column">
        <Box>
          <Text bold>Council Mode {isOn ? 'ON' : 'off'} </Text>
          <Button key="toggle" label={isOn ? 'Turn off' : 'Turn on'} onPress={() => setEnabled($, !isOn)} />
        </Box>
        {pick('target', [7, 7.5, 8, 8.5, 9, 9.5, 10])}
        {pick('rounds', [1, 2, 3, 4, 5, 6, 7, 8, 9, 10])}
        {pick('reviewers', [2, 3, 4, 5])}
        <Text dimColor>Lowest score decides. Critical/high findings block. Settings apply to the next task.</Text>
        {!r && <Text dimColor>No council run yet. Turn it on, then type a task.</Text>}
        {r && (
          <Box flexDirection="column">
            <Text>Task: {r.task}</Text>
            <Text>Status: {r.status.replace(/_/g, ' ')} · lenses {r.lenses.join(', ')}</Text>
            {r.rounds.map(x => (
              <Progress
                key={`round-${x.number}`}
                label={`Round ${x.number}${x.passed ? ' passed' : ''}`}
                value={x.score}
                max={10}
                valueText={`${x.score} / ${r.config.target}, ${x.blockers} blocking`}
                color={x.passed ? 'green' : 'red'}
              />
            ))}
            {r.status === 'reviewing' && (
              <Progress label="Reviewers reporting" value={r.partial.length} max={r.lenses.length} valueText={`${r.partial.length} of ${r.lenses.length}`} />
            )}
            {last?.reviews.map(v => (
              <Box key={`review-${v.agentId}`} flexDirection="column">
                <Text bold>
                  {v.lens}: {v.score}
                  {v.error ? ` (invalid: ${v.error})` : ''}
                </Text>
                {v.findings.map((f, i) => (
                  <Text key={`f-${v.agentId}-${i}`} color={f.severity === 'critical' || f.severity === 'high' ? 'red' : undefined}>
                    {'  '}[{f.severity}] {f.location}: {f.evidence}
                  </Text>
                ))}
                {v.limitations.length > 0 && <Text dimColor>{'  '}limits: {v.limitations.join('; ')}</Text>}
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
