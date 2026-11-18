import type { UsageWindow } from '../types'

import type { Messages } from './i18n'

export const WARN_AT = 80
export const DANGER_AT = 95
/** A toast fires once when a window crosses this, going up. */
export const NOTIFY_AT = 90

const MINUTE = 60_000

export const toWindows = (
  limits: readonly { kind: string; percentUsed: number; resetsAt?: string }[],
): UsageWindow[] =>
  limits.map(({ kind, percentUsed, resetsAt }) => ({ kind, percentUsed, resetsAt }))

export const hasReset = (window: UsageWindow, now: number): boolean =>
  window.resetsAt !== undefined && Date.parse(window.resetsAt) <= now

/** The share used as of `now`: a window whose reset has passed reads 0. */
export const percentNow = (window: UsageWindow, now: number): number =>
  hasReset(window, now) ? 0 : window.percentUsed

/** Whether the window is used up as of `now` (a refusal, not yet reset). */
export const isExhausted = (window: UsageWindow, now: number): boolean =>
  window.isExhausted === true && !hasReset(window, now)

/** Below this, a `rate_limit` refusal is not taken for a plan limit without a hint. */
const EXHAUST_FLOOR = 80

/** The window a refusal's details name: `weekly` / `7-day` / `Opus` / `5-hour`. */
const windowNamed = (details: string): string | undefined => {
  if (/opus/i.test(details)) return 'seven_day_opus'
  if (/sonnet/i.test(details)) return 'seven_day_sonnet'
  if (/week|7.?day/i.test(details)) return 'seven_day'
  if (/5.?hour|session/i.test(details)) return 'five_hour'
  return undefined
}

/**
 * Marks the window a usage-limit refusal hit as used up: the one the details
 * name, else the fullest one when it is near its limit. Unchanged when the
 * refusal does not look like a plan limit (a short burst limit, say).
 */
export const exhaust = (windows: readonly UsageWindow[], details = ''): UsageWindow[] => {
  const named = windowNamed(details)
  const fullest = windows.reduce<UsageWindow | undefined>(
    (best, window) => (best === undefined || window.percentUsed > best.percentUsed ? window : best), undefined)
  const target = (named && windows.find(window => window.kind === named))
    ?? (fullest && fullest.percentUsed >= EXHAUST_FLOOR ? fullest : undefined)
  if (target === undefined) return [...windows]
  return windows.map(window =>
    window === target ? { ...window, percentUsed: Math.max(100, window.percentUsed), isExhausted: true } : window)
}

export const severity = (percent: number): 'success' | 'warning' | 'error' =>
  percent >= DANGER_AT ? 'error' : percent >= WARN_AT ? 'warning' : 'success'

export const span = (ms: number, t: Messages): string => {
  const minutes = Math.max(1, Math.round(ms / MINUTE))
  return t.duration(Math.floor(minutes / 1440), Math.floor((minutes % 1440) / 60), minutes % 60)
}

/** Time until the window resets, or undefined when unknown or past. */
export const resetsIn = (window: UsageWindow, now: number, t: Messages): string | undefined => {
  if (window.resetsAt === undefined) return undefined
  const left = Date.parse(window.resetsAt) - now
  return left > 0 ? span(left, t) : undefined
}

export const bar = (percent: number, width = 10): string => {
  const filled = Math.min(width, Math.round((Math.min(100, Math.max(0, percent)) / 100) * width))
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

/** Windows that went from below `threshold` to at or above it. */
export const crossed = (
  before: readonly UsageWindow[],
  after: readonly UsageWindow[],
  threshold = NOTIFY_AT,
): UsageWindow[] =>
  after.filter(window => {
    const previous = before.find(other => other.kind === window.kind)
    return window.percentUsed >= threshold && (previous?.percentUsed ?? 0) < threshold
  })
