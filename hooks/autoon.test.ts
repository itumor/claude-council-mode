import { expect, test } from 'claude-code/testing'

// The hooks here stand for the engine beneath the plugin: they answer what session.start
// registers and record every `enabled` write the plugin makes.

test('autoOn turns Council on at session start', { options: { autoOn: true } }, async ($, on) => {
  const writes: unknown[] = []
  on('command.register', () => ({ value: { command: 'council' } }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__council__${(e as unknown as { name: string }).name}` } }))
  on('store.get', () => ({ value: undefined }))
  on('state.set', (_, e) => {
    const w = e as unknown as { key: string; value: unknown }
    if (w.key === 'enabled') writes.push(w.value)
    return { value: { isSet: true, version: 1 } }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  expect(writes).toEqual([true])
})

test('autoOn defaults to off: session start writes nothing to enabled', async ($, on) => {
  const writes: unknown[] = []
  on('command.register', () => ({ value: { command: 'council' } }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__council__${(e as unknown as { name: string }).name}` } }))
  on('store.get', () => ({ value: undefined }))
  on('state.set', (_, e) => {
    const w = e as unknown as { key: string; value: unknown }
    if (w.key === 'enabled') writes.push(w.value)
    return { value: { isSet: true, version: 1 } }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  expect(writes).toEqual([])
})

test('autoOn never overrides a user Off (session.start re-runs on reload)', { options: { autoOn: true } }, async ($, on) => {
  const writes: unknown[] = []
  on('command.register', () => ({ value: { command: 'council' } }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__council__${(e as unknown as { name: string }).name}` } }))
  on('store.get', () => ({ value: undefined }))
  // $.state outlives a reload: the user's Off left lockedOff = true.
  on('state.get', (_, e, next) => ((e as unknown as { key: string }).key === 'lockedOff' ? { value: { value: true, version: 1 } } : next(e)))
  on('state.set', (_, e) => {
    const w = e as unknown as { key: string; value: unknown }
    if (w.key === 'enabled') writes.push(w.value)
    return { value: { isSet: true, version: 1 } }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  expect(writes).toEqual([])
})
