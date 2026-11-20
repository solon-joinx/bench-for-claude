import type { EngineInterface } from 'claude-code'

import type { Account, BandView, Snapshot, UsageWindow } from '../types'

import type { Messages } from './i18n'
import { labelOf } from './registry'
import { bar, hasReset, isExhausted, percentNow, resetsIn, severity, span } from './usage'

/** A reading of the signed-in account older than this shows its age. */
const STALE_MS = 5 * 60_000

type Elements = ReturnType<EngineInterface['ui']['resolve']>

type BandInput = {
  ui: Elements
  /** The signed-in account's reading. */
  current: Snapshot | null
  /** Every known account's last reading; the signed-in one is skipped here. */
  accounts: readonly Snapshot[]
  view: Exclude<BandView, 'hidden'>
  now: number
  t: Messages
  /** Switches to another account; the expanded band draws a button for it. */
  onSwitch?: (account: Account) => void
  /** Flips compact <-> expanded; drawn as the band's last control. */
  onToggle?: () => void
}

const accountLabel = (snapshot: Snapshot | null, t: Messages, withPlan: boolean): string => {
  const account = snapshot?.account
  const who = (account && labelOf(account)) ?? t.unknownAccount
  return withPlan && account?.plan ? `${who} · ${account.plan}` : who
}

const age = (snapshot: Snapshot, now: number, t: Messages, threshold: number): string | undefined =>
  snapshot.measuredAt > 0 && now - snapshot.measuredAt > threshold
    ? t.ago(span(now - snapshot.measuredAt, t))
    : undefined

const windowCell = (ui: Elements, window: UsageWindow, now: number, t: Messages, opts: {
  withBar: boolean
  withCountdown: boolean
}) => {
  const { Box, Text } = ui
  const percent = percentNow(window, now)
  const left = opts.withCountdown ? resetsIn(window, now, t) : undefined

  return (
    <Box key={window.kind} flexDirection="row" gap={1}>
      <Text dimColor>{t.window(window.kind)}</Text>
      {opts.withBar ? <Text color={severity(percent)}>{bar(percent)}</Text> : null}
      {hasReset(window, now)
        ? <Text color="success">{t.reset}</Text>
        : isExhausted(window, now)
          ? <Text color="error" bold>{t.exhausted}</Text>
          : <Text color={severity(percent)}>{`${Math.round(percent)}%`}</Text>}
      {left ? <Text dimColor>{`↻${left}`}</Text> : null}
    </Box>
  )
}

/** One account: its header and its windows, in one line or as a block. */
const accountBlock = (ui: Elements, snapshot: Snapshot | null, isCurrent: boolean, input: BandInput) => {
  const { Box, Button, Text } = ui
  const { now, t } = input
  const isExpanded = input.view === 'expanded'
  const windows = snapshot?.windows ?? []
  const stale = windows.length > 0 && snapshot
    ? age(snapshot, now, t, isCurrent ? STALE_MS : 0)
    : undefined
  // Other accounts stay terse on the compact line.
  const isFull = isCurrent || isExpanded

  const account = snapshot?.account
  const onSwitch = input.onSwitch
  // No hotkey: a band Button's digit is pressed by a bare digit typed into an
  // empty prompt, so a message starting with a number would switch accounts.
  const switchButton = isExpanded && !isCurrent && account && onSwitch
    ? <Button key={`use-${account.id}`} label={t.switchButton} onPress={() => onSwitch(account)} />
    : null

  const header = (
    <Box flexDirection="row" gap={1}>
      {isCurrent ? <Text color="claude">●</Text> : <Text dimColor>○</Text>}
      <Text dimColor={!isCurrent}>{accountLabel(snapshot, t, isFull)}</Text>
      {stale && isFull ? <Text dimColor>{`(${stale})`}</Text> : null}
      {switchButton}
    </Box>
  )

  const cells = windows.length === 0
    ? [<Text key="empty" dimColor>{isCurrent ? t.waiting : t.noData}</Text>]
    : windows.map(window => windowCell(ui, window, now, t, { withBar: isExpanded, withCountdown: isFull }))

  const key = snapshot?.account?.id ?? 'current'

  return isExpanded
    ? (
      <Box key={key} flexDirection="column">
        {header}
        <Box flexDirection="column" paddingLeft={2}>{cells}</Box>
      </Box>
    )
    : <Box key={key} flexDirection="row" gap={2}>{header}{cells}</Box>
}

/** The band above the prompt: the signed-in account first, then the others. */
export const band = (input: BandInput) => {
  const { ui, current, accounts, t, onToggle } = input
  const { Box, Button, Text } = ui
  const isExpanded = input.view === 'expanded'
  const toggle = onToggle
    ? <Button key="toggle" label={isExpanded ? t.collapseButton : t.expandButton} hotkey="e" onPress={onToggle} />
    : null
  const currentId = current?.account?.id
  const others = accounts.filter(snapshot => snapshot.account?.id !== currentId)

  const blocks = [
    accountBlock(ui, current, true, input),
    ...others.map(other => accountBlock(ui, other, false, input)),
  ]

  if (isExpanded) {
    return <Box flexDirection="column">{blocks}{toggle}</Box>
  }

  const line = blocks.flatMap((block, index) =>
    index === 0 ? [block] : [<Text key={`sep-${index}`} dimColor>│</Text>, block])
  if (toggle) line.push(toggle)

  return <Box flexDirection="row" gap={2} flexWrap="wrap">{line}</Box>
}
