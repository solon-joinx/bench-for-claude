import { expect, test } from 'claude-code/testing'

import type { Snapshot } from '../types'

import { messages, resolveLocale } from '../hooks/i18n'
import { findAccount } from '../hooks/registry'
import { crossed, exhaust, percentNow, span } from '../hooks/usage'

const NOW = Date.parse('2026-11-18T12:00:00Z')

const SNAPSHOT: Snapshot = {
  account: { id: 'acc-1', email: 'dev@example.com', plan: 'Max 20x' },
  windows: [
    { kind: 'five_hour', percentUsed: 62, resetsAt: '2026-11-18T13:20:00Z' },
    { kind: 'seven_day', percentUsed: 31, resetsAt: '2026-11-21T12:00:00Z' },
  ],
  measuredAt: NOW,
}

const BAND = {
  plugin: 'bench-for-claude',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 8,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 8 },
    view: {},
  },
} as const

/** Answers every state read of the band from one table. */
const seed = (values: Record<string, unknown>) => (_: unknown, e: { key: string }) =>
  e.key in values ? { value: { value: values[e.key], version: 1 } } : { value: { value: undefined, version: 0 } }

test('locale: option wins, then the language setting, then English', () => {
  expect(resolveLocale('en', '繁體中文')).toBe('en')
  expect(resolveLocale('auto', '繁體中文')).toBe('zh-TW')
  expect(resolveLocale('auto', 'Traditional Chinese')).toBe('zh-TW')
  expect(resolveLocale('auto', 'japanese')).toBe('en')
  expect(resolveLocale(undefined, undefined)).toBe('en')
})

test('a window past its reset reads as 0%', () => {
  const window = { kind: 'five_hour', percentUsed: 80, resetsAt: '2026-11-18T11:00:00Z' }
  expect(percentNow(window, NOW)).toBe(0)
})

test('durations are compact in each language', () => {
  expect(span(80 * 60_000, messages('en'))).toBe('1h20m')
  expect(span(3 * 86_400_000, messages('zh-TW'))).toBe('3天')
})

test('the 90% toast fires once, on the way up', () => {
  const at = (percentUsed: number) => [{ kind: 'five_hour', percentUsed }]
  expect(crossed(at(85), at(91)).length).toBe(1)
  expect(crossed(at(91), at(93)).length).toBe(0)
})

test('compact band shows the account and both windows', async ($, on) => {
  on('state.get', seed({ snapshot: SNAPSHOT, view: 'compact', locale: 'en', now: NOW }))

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect((await ui.find({ type: 'Text', text: /dev@example/ }))?.text).toBe('dev@example.com · Max 20x')
    expect((await ui.find({ type: 'Text', text: '62%' }))?.text).toBe('62%')
    expect((await ui.find({ type: 'Text', text: '↻1h20m' }))?.text).toBe('↻1h20m')
    expect((await ui.find({ type: 'Text', text: '↻3d' }))?.text).toBe('↻3d')
    await ui.unmount()
  }
})

test('expanded band draws bars, in Traditional Chinese', async ($, on) => {
  on('state.get', seed({ snapshot: SNAPSHOT, view: 'expanded', locale: 'zh-TW', now: NOW }))

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: '██████░░░░' }))?.text).toBe('██████░░░░')
  expect((await ui.find({ type: 'Text', text: '↻1時20分' }))?.text).toBe('↻1時20分')
  await ui.unmount()
})

test('before the first reply the band says usage is coming', async ($, on) => {
  on('state.get', seed({ snapshot: { ...SNAPSHOT, windows: [] }, view: 'compact', locale: 'en', now: NOW }))

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /first reply/ }))?.text).toBe('Usage appears after the first reply')
  await ui.unmount()
})

test('a hidden band leaves the slot to the engine', async ($, on) => {
  on('state.get', seed({ view: 'hidden' }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: 'engine' }))?.text).toBe('engine')
  expect(await ui.find({ type: 'Text', text: /first reply/ })).toBeFalsy()
  await ui.unmount()
})

const OTHER: Snapshot = {
  account: { id: 'acc-2', email: 'me@example.com', plan: 'Pro', alias: 'personal' },
  windows: [
    { kind: 'five_hour', percentUsed: 70, resetsAt: '2026-11-18T10:00:00Z' },
    { kind: 'seven_day', percentUsed: 18, resetsAt: '2026-11-23T12:00:00Z' },
  ],
  measuredAt: NOW - 12 * 60_000,
}

test('accounts are found by alias, email or name', () => {
  const list = [OTHER.account!, SNAPSHOT.account!]
  expect(findAccount(list, 'Personal')?.id).toBe('acc-2')
  expect(findAccount(list, 'dev@example.com')?.id).toBe('acc-1')
  expect(findAccount(list, 'nobody')).toBeUndefined()
})

test('compact band lists other accounts after the signed-in one', async ($, on) => {
  on('state.get', seed({ snapshot: SNAPSHOT, accounts: [SNAPSHOT, OTHER], view: 'compact', locale: 'zh-TW', now: NOW }))

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  // The other account: its alias, its 5h window already reset, its 7d share.
  expect((await ui.find({ type: 'Text', text: 'personal' }))?.text).toBe('personal')
  expect((await ui.find({ type: 'Text', text: '已重置' }))?.text).toBe('已重置')
  expect((await ui.find({ type: 'Text', text: '18%' }))?.text).toBe('18%')
  // Compact keeps other accounts terse: no countdown, no age.
  expect(await ui.find({ type: 'Text', text: '↻5天' })).toBeFalsy()
  await ui.unmount()
})

test('expanded band shows how old another account\'s reading is', async ($, on) => {
  on('state.get', seed({ snapshot: SNAPSHOT, accounts: [SNAPSHOT, OTHER], view: 'expanded', locale: 'en', now: NOW }))

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /personal/ }))?.text).toBe('personal · Pro')
  expect((await ui.find({ type: 'Text', text: /ago/ }))?.text).toBe('(12m ago)')
  await ui.unmount()
})

test('a usage-limit refusal marks the window it names, else the fullest near-full one', () => {
  const windows = [
    { kind: 'five_hour', percentUsed: 96, resetsAt: '2026-11-18T13:00:00Z' },
    { kind: 'seven_day', percentUsed: 40, resetsAt: '2026-11-21T12:00:00Z' },
  ]
  expect(exhaust(windows).map(w => w.isExhausted ?? false)).toEqual([true, false])
  expect(exhaust(windows)[0]?.percentUsed).toBe(100)
  expect(exhaust(windows, 'Weekly limit reached').map(w => w.isExhausted ?? false)).toEqual([false, true])
  // Nowhere near a plan limit: a burst rate limit, left alone.
  expect(exhaust([{ kind: 'five_hour', percentUsed: 30 }]).some(w => w.isExhausted)).toBe(false)
})

test('a used-up window says so until it resets', async ($, on) => {
  const out: Snapshot = { ...SNAPSHOT, windows: exhaust(SNAPSHOT.windows, '5-hour limit') }
  const values: Record<string, unknown> = { snapshot: out, view: 'compact', locale: 'zh-TW', now: NOW }
  on('state.get', (_, e) => seed(values)(_, e))
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: '已用完' }))?.text).toBe('已用完')
  await ui.unmount()

  // Past its reset time the same window reads as reset.
  values.now = NOW + 2 * 3_600_000
  const later = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await later.find({ type: 'Text', text: '已用完' })).toBeFalsy()
  await later.unmount()
})
