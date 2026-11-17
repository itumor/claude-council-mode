import { expect, test } from 'claude-code/testing'

import { applyReview, finishSpawning, newRun, parseReview, recordSpawn, startReview } from './gate'
import type { Run } from '../contract'

const review = (score: number, findings: unknown[] = []) =>
  JSON.stringify({ score, findings, verified: ['read hosts.ts'], limitations: [] })

// Round 1 closed: correctness 9.5 passes, security 6.0 with a high finding.
function fixing(): Run {
  const started = startReview(newRun('add SSH hosts', { target: 9, rounds: 10, reviewers: 2 }), [], 0)
  if (!started) throw new Error('startReview refused')
  let r = finishSpawning(recordSpawn(recordSpawn(started, 'a1', 'security'), 'a2', 'correctness'), [])
  const high = { severity: 'high', location: 'hosts.json', evidence: 'password in plain text', fix: 'keychain' }
  r = applyReview(r, parseReview(review(6, [high]), 'security', 'a1'))
  return applyReview(r, parseReview(review(9.5), 'correctness', 'a2'))
}

const base = { scroll: { offset: 0, bodyRows: 20 }, view: {}, bodyColumns: 80 }
const BAND = { plugin: 'council', component: 'AbovePrompt', props: { ...base, hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 20 } } as const
const PANE = { plugin: 'council', component: 'Pane', requestId: 'council', props: { ...base, title: 'Council', isFocused: false, placement: 'dock' } } as const

test('band and pane draw the fixing round on terminal and desktop', async ($, on) => {
  const run = fixing()
  on('state.get', (_, e, next) => {
    const key = (e as unknown as { key: string }).key
    return key === 'enabled' ? { value: { value: true, version: 1 } } : key === 'run' ? { value: { value: { shape: 'run-2', value: run }, version: 1 } } : next(e)
  })
  for (const surface of ['terminal', 'desktop'] as const) {
    const band = await $.ui.mount({ ...BAND, surface })
    expect((await band.find({ type: 'Text', text: /Round 1 of 10/ }))?.text).toContain('fixing')
    expect((await band.find({ type: 'Text', text: /6 \/ 9/ }))?.text).toBe('6 / 9')
    expect((await band.find({ type: 'Text', text: /blocking/ }))?.text).toBe('6 · 1 blocking')
    await band.unmount()

    const pane = await $.ui.mount({ ...PANE, surface })
    expect((await pane.find({ type: 'Text', text: /plain text/ }))?.text).toContain('[high] hosts.json')
    await pane.unmount()
  }
})
