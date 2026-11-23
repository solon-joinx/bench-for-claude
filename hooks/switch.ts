import type { EngineInterface } from 'claude-code'

import type { Account } from '../types'

import { readProfile, writeProfile } from './account'
import { capture, installLive, isExpired, isSupported, readVault } from './credentials'

// A switch writes Claude Code's login and then the global config; for that moment the
// two disagree. Every session skips capturing logins while this is set, so no
// session files one account's login under the other's id.
const SWITCHING_UNTIL = 'switchingUntil'
const SWITCH_WINDOW_MS = 15_000

// Every session follows a switch on its own: Claude Code reads the login again
// before each request. That read is cached for up to 30 seconds, so for a while
// after a switch a session's requests may still carry the old login.
const SWITCHED_AT = 'switchedAt'
const SETTLE_MS = 45_000

export type SwitchResult =
  | { ok: true }
  | { ok: false; reason: 'unsupported' | 'current' | 'notCaptured' | 'expired' }
  | { ok: false; reason: 'failed'; detail: string }

export async function isSwitching($: EngineInterface): Promise<boolean> {
  const until = await $.store.get(SWITCHING_UNTIL)
  return typeof until === 'number' && until > (await $.clock.now())
}

/** Whether a switch is recent enough that sessions may not all have followed it yet. */
export async function isSettling($: EngineInterface): Promise<boolean> {
  const at = await $.store.get(SWITCHED_AT)
  return typeof at === 'number' && (await $.clock.now()) - at < SETTLE_MS
}

/**
 * Makes `target` the signed-in account for Claude Code on this machine: its
 * saved login goes into Claude Code's credentials item and its profile into the
 * global config. The outgoing account's latest login is saved first. When the
 * config cannot be written, the credentials item is put back as it was.
 */
export async function switchAccount(
  $: EngineInterface,
  target: Account,
  currentId: string | undefined,
): Promise<SwitchResult> {
  if (target.id === currentId) return { ok: false, reason: 'current' }
  if (!(await isSupported($))) return { ok: false, reason: 'unsupported' }

  const entry = await readVault($, target.id)
  const profile = entry?.profile
  if (entry === undefined || profile === undefined) return { ok: false, reason: 'notCaptured' }
  if (isExpired(entry.oauth, await $.clock.now())) return { ok: false, reason: 'expired' }

  await $.store.set(SWITCHING_UNTIL, (await $.clock.now()) + SWITCH_WINDOW_MS)
  try {
    const outgoing = await readProfile($)
    if (currentId !== undefined && outgoing !== undefined) await capture($, currentId, outgoing)
    const restore = await installLive($, entry.oauth)
    try {
      await writeProfile($, profile)
    } catch (error) {
      await restore()
      throw error
    }
    await $.store.set(SWITCHED_AT, await $.clock.now())
    return { ok: true }
  } catch (error) {
    return { ok: false, reason: 'failed', detail: error instanceof Error ? error.message : String(error) }
  } finally {
    await $.store.delete(SWITCHING_UNTIL)
  }
}
