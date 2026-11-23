import type { EngineInterface } from 'claude-code'

import type { Account } from '../types'

import { readProfile, toAccount, writeProfile } from './account'
import type { Profile } from './account'
import {
  capture, installLive, isRevoked, isSupported, loginState, markDead, readLiveOAuth, readVault,
} from './credentials'
import type { VaultEntry } from './credentials'

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

// A switch stays pending until the new account is seen answering. A saved
// login can look fine and still be revoked (signed out on claude.ai, say): the
// first request then fails and Claude Code empties its login. While the switch
// is pending, that sends everyone back to the account switched from.
const PENDING = 'pendingSwitch'
type Pending = { from?: string; to: string; at: number }

export type SwitchResult =
  | { ok: true }
  | { ok: false; reason: 'unsupported' | 'current' | 'notCaptured' | 'expired' | 'revoked' }
  | { ok: false; reason: 'failed'; detail: string }

/** A signed-in login found revoked; `switchedBack` when the switch to it was undone. */
export type RevokedLogin = { account: Account; switchedBack?: Account }

export async function isSwitching($: EngineInterface): Promise<boolean> {
  const until = await $.store.get(SWITCHING_UNTIL)
  return typeof until === 'number' && until > (await $.clock.now())
}

/** Whether a switch is recent enough that sessions may not all have followed it yet. */
export async function isSettling($: EngineInterface): Promise<boolean> {
  const at = await $.store.get(SWITCHED_AT)
  return typeof at === 'number' && (await $.clock.now()) - at < SETTLE_MS
}

async function pending($: EngineInterface): Promise<Pending | undefined> {
  const value = await $.store.get(PENDING)
  return value && typeof value === 'object' ? (value as Pending) : undefined
}

/**
 * Puts a saved login in Claude Code's item and its profile in the global
 * config. `before` runs first, inside the switching window. When the config
 * cannot be written, the credentials item is put back as it was.
 */
async function install(
  $: EngineInterface,
  entry: VaultEntry & { profile: Profile },
  before?: () => Promise<void>,
): Promise<void> {
  await $.store.set(SWITCHING_UNTIL, (await $.clock.now()) + SWITCH_WINDOW_MS)
  try {
    await before?.()
    const restore = await installLive($, entry.oauth)
    try {
      await writeProfile($, entry.profile)
    } catch (error) {
      await restore()
      throw error
    }
    await $.store.set(SWITCHED_AT, await $.clock.now())
  } finally {
    await $.store.delete(SWITCHING_UNTIL)
  }
}

/**
 * Makes `target` the signed-in account for Claude Code on this machine: its
 * saved login goes into Claude Code's credentials item and its profile into the
 * global config. The outgoing account's latest login is saved first.
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
  const state = loginState(entry, await $.clock.now())
  if (state !== 'ok') return { ok: false, reason: state }

  try {
    await install($, { ...entry, profile }, async () => {
      const outgoing = await readProfile($)
      if (currentId !== undefined && outgoing !== undefined) await capture($, currentId, outgoing)
    })
    const record: Pending = { from: currentId, to: target.id, at: await $.clock.now() }
    await $.store.set(PENDING, record)
    return { ok: true }
  } catch (error) {
    return { ok: false, reason: 'failed', detail: error instanceof Error ? error.message : String(error) }
  }
}

/** The account switched to answered with its usage: the switch worked. */
export async function confirmSwitch($: EngineInterface, accountId: string): Promise<void> {
  if ((await pending($))?.to === accountId) await $.store.delete(PENDING)
}

/**
 * Looks at the signed-in login. When Claude Code has given up on it, marks the
 * account's saved login dead and, if a switch to it is still pending, switches
 * back to the account it came from. Returns what happened the first time a
 * login is found revoked, and undefined otherwise (also on later looks).
 */
export async function checkLogin($: EngineInterface): Promise<RevokedLogin | undefined> {
  const profile = await readProfile($)
  const account = toAccount(profile)
  if (profile === undefined || account === null) return undefined

  const switching = await pending($)
  // Signed in with something else since (a /login, another switch): nothing to undo.
  if (switching !== undefined && switching.to !== account.id) await $.store.delete(PENDING)

  const live = await readLiveOAuth($)
  if (live === undefined || !isRevoked(live)) return undefined

  const now = await $.clock.now()
  if (!(await markDead($, account.id, profile, now))) return undefined
  if (switching?.to !== account.id) return { account }

  await $.store.delete(PENDING)
  const back = switching.from === undefined ? undefined : await readVault($, switching.from)
  const backProfile = back?.profile
  if (back === undefined || backProfile === undefined || loginState(back, now) !== 'ok') return { account }
  try {
    await install($, { ...back, profile: backProfile })
  } catch {
    return { account }
  }
  return { account, switchedBack: toAccount(backProfile) ?? undefined }
}
