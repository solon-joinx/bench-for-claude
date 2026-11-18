import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Account, BandView, Snapshot } from '../types'

import { readProfile, toAccount } from './account'
import { band } from './band'
import { capture, deleteVault, isSupported, listVault, readVault, setVaultAlias } from './credentials'
import { messages, resolveLocale } from './i18n'
import type { Messages } from './i18n'
import {
  findAccount, forget, labelOf, loadAll, loadRegistry, loadSnapshot, remember, saveSnapshot, setAlias,
} from './registry'
import { isSwitching, switchAccount } from './switch'
import { crossed, exhaust, hasReset, isExhausted, percentNow, span, toWindows } from './usage'

const COMMAND = 'accounts'
const TICK_MS = 60_000

// Session state the band draws from (declared in types/index.d.ts).
const snapshot = atom({ plugin: 'bench-for-claude', key: 'snapshot' } as const, null)
const accounts = atom({ plugin: 'bench-for-claude', key: 'accounts' } as const, [])
const view = atom({ plugin: 'bench-for-claude', key: 'view' } as const, 'compact')
const locale = atom({ plugin: 'bench-for-claude', key: 'locale' } as const, 'en')
const now = atom({ plugin: 'bench-for-claude', key: 'now' } as const, 0)
const sessionAccount = atom({ plugin: 'bench-for-claude', key: 'sessionAccount' } as const, null)

/** The band layout is remembered across sessions under this store key. */
const STORE_VIEW = 'view'

const VIEWS: readonly BandView[] = ['compact', 'expanded', 'hidden']
const isView = (value: unknown): value is BandView => VIEWS.includes(value as BandView)

/** `/accounts` with no argument flips compact <-> expanded, and shows a hidden band. */
const nextView = (current: BandView, word: string): BandView | undefined => {
  if (word === '') return current === 'compact' ? 'expanded' : 'compact'
  if (word === 'hide') return 'hidden'
  if (word === 'show') return current === 'hidden' ? 'compact' : current
  return isView(word) ? word : undefined
}

// Per module load, set at session.start (a reload runs it again).
/** The account this session started with; kept in session state so a reload keeps it. */
let sessionAccountId: string | undefined
/** Whether logins can be saved and switched on this machine. */
let canSwitch = false

/**
 * Reads the signed-in account and records its profile and latest login. Runs
 * on every measurement and every tick, so a /login in any session (with or
 * without this mod) is picked up within a minute.
 */
async function track($: EngineInterface): Promise<Account | null> {
  const profile = await readProfile($)
  const found = toAccount(profile)
  const account = found && (await remember($, found))
  if (account && profile && canSwitch && !(await isSwitching($))) {
    await capture($, account.id, profile)
  }
  return account
}

/** Adds every account in the Keychain vault the store does not know yet, with its alias. */
async function restoreFromVault($: EngineInterface): Promise<void> {
  const known = await loadRegistry($)
  for (const id of await listVault($)) {
    if (known[id] !== undefined) continue
    const entry = await readVault($, id)
    const account = toAccount(entry?.profile)
    if (account) await remember($, { ...account, alias: entry?.alias })
  }
}

/** An account's last stored reading, or an empty one. */
async function storedReading($: EngineInterface, account: Account): Promise<Snapshot> {
  const stored = await loadSnapshot($, account.id)
  return { windows: [], measuredAt: 0, ...stored, account }
}

/**
 * Pairs the signed-in account with the given rate limits and records them.
 *
 * Once the config names another account than the one this session started
 * with (a switch or a /login, here or in another session), this session's
 * readings may still come from the old login, so they are not recorded: the
 * reading shown is the new account's stored one.
 */
async function measure($: EngineInterface, limits: Parameters<typeof toWindows>[0]): Promise<Snapshot> {
  const account = await track($)
  if (account && account.id !== sessionAccountId) return storedReading($, account)

  const reading: Snapshot = { account, windows: toWindows(limits), measuredAt: await $.clock.now() }
  if (reading.windows.length > 0) await saveSnapshot($, reading)
  return reading
}

/** Reloads every account's reading from the store, which other sessions also write. */
async function refreshAccounts($: EngineInterface): Promise<Snapshot[]> {
  const all = await loadAll($)
  await update($, accounts, () => all)
  return all
}

const summary = (reading: Snapshot, time: number, t: Messages): string => {
  if (reading.windows.length === 0) return t.noData
  const windows = reading.windows
    .map(w => {
      const state = hasReset(w, time) ? t.reset : isExhausted(w, time) ? t.exhausted : `${Math.round(percentNow(w, time))}%`
      return `${t.window(w.kind)} ${state}`
    })
    .join(' · ')
  return reading.measuredAt > 0 ? `${windows} (${t.ago(span(time - reading.measuredAt, t))})` : windows
}

/** Switches to `target` and returns the line to show the person. */
async function useAccount($: EngineInterface, target: Account, t: Messages): Promise<string> {
  const current = (await read($, snapshot))?.account ?? null
  const label = labelOf(target) ?? target.id

  const result = await switchAccount($, target, current?.id)
  if (!result.ok) {
    const reasons = {
      unsupported: t.switchUnsupported,
      current: t.alreadyCurrent(label),
      notCaptured: t.notCaptured(label),
      expired: t.loginExpired(label),
      failed: t.switchFailed(result.reason === 'failed' ? result.detail : ''),
    }
    return reasons[result.reason]
  }

  // Show the new account right away, with its last stored reading.
  const reading = await storedReading($, target)
  await update($, snapshot, () => reading)
  await refreshAccounts($)
  return t.switched(label)
}

const listText = (all: readonly Snapshot[], currentId: string | undefined, time: number, t: Messages): string => {
  if (all.length === 0) return t.listEmpty
  return all.flatMap(reading => {
    const account = reading.account
    if (!account) return []
    const marker = account.id === currentId ? '●' : '○'
    const email = account.alias && account.email ? ` (${account.email})` : ''
    const plan = account.plan ? ` · ${account.plan}` : ''
    return [`${marker} ${labelOf(account) ?? t.unknownAccount}${email}${plan} — ${summary(reading, time, t)}`]
  }).join('\n')
}

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)

    const lang = resolveLocale(options.language, await $.settings.read({ key: 'language' }))
    await update($, locale, () => lang)

    const savedView = await $.store.get(STORE_VIEW)
    if (isView(savedView)) await update($, view, () => savedView)

    // The first load in a session fixes its account; a reload reads it back.
    const startedWith = (await read($, sessionAccount)) ?? toAccount(await readProfile($))?.id ?? null
    await update($, sessionAccount, () => startedWith)
    sessionAccountId = startedWith ?? undefined
    canSwitch = await isSupported($)
    if (canSwitch) await restoreFromVault($)

    // Seed from what the session already knows; before the first reply that is
    // usually nothing, so fall back to this account's last stored reading.
    const reading = await measure($, (await $.session.usage()).rateLimits)
    const stored = reading.windows.length === 0 && reading.account
      ? await loadSnapshot($, reading.account.id)
      : undefined
    await update($, snapshot, () => (stored ? { ...stored, account: reading.account } : reading))
    await refreshAccounts($)

    await update($, now, () => reading.measuredAt)
    $.clock.every(TICK_MS, async () => {
      const time = await $.clock.now()
      await update($, now, () => time)

      // Another session may have signed in with, or switched to, another account.
      const account = await track($)
      if (account && account.id !== (await read($, snapshot))?.account?.id) {
        const reading = await storedReading($, account)
        await update($, snapshot, () => reading)
      }
      await refreshAccounts($)
    })

    await $.command.register({
      name: COMMAND,
      description: messages(lang).commandDescription,
      argumentHint: 'use <account> | compact | expanded | hide | show | name <alias> | remove <account> | list',
    })

    return started
  })

  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('rateLimits')) {
      const before = (await read($, snapshot))?.windows ?? []
      const reading = await measure($, e.rateLimits)
      await update($, snapshot, () => reading)
      await update($, now, () => reading.measuredAt)
      await refreshAccounts($)

      const t = messages(await read($, locale))
      for (const window of crossed(before, reading.windows)) {
        $.ui.toast(t.nearLimit(t.window(window.kind), Math.round(window.percentUsed)))
      }
    }

    return next(e)
  })

  // A request refused for a usage limit reports no new reading, so the last one
  // can sit at 96% on an account that is out. Mark the window used up instead.
  on('classic.StopFailure', async ($, e, next) => {
    if (e.error === 'rate_limit' && sessionAccountId !== undefined) {
      const account = (await loadAll($)).find(s => s.account?.id === sessionAccountId)
      if (account?.account && account.windows.length > 0) {
        const marked: Snapshot = { ...account, windows: exhaust(account.windows, e.error_details ?? '') }
        await saveSnapshot($, marked)
        if ((await read($, snapshot))?.account?.id === sessionAccountId) {
          await update($, snapshot, () => marked)
        }
        await refreshAccounts($)
      }
    }

    return next(e)
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    const t = messages(await read($, locale))
    const [first = '', ...rest] = e.args.trim().split(/\s+/)
    const word = first.toLowerCase()
    const argument = rest.join(' ')
    const current = (await read($, snapshot))?.account ?? null

    if (word === 'list') {
      const all = await refreshAccounts($)
      return { text: listText(all, current?.id, await $.clock.now(), t) }
    }

    if (word === 'use') {
      const all = await refreshAccounts($)
      const target = findAccount(all.flatMap(s => (s.account ? [s.account] : [])), argument)
      if (target === undefined) return { text: t.notFound(argument) }
      return { text: await useAccount($, target, t) }
    }

    if (word === 'name') {
      if (current === null) return { text: t.notSignedIn }
      const alias = argument === '' ? undefined : argument
      await setAlias($, current.id, alias)
      if (canSwitch) await setVaultAlias($, current.id, alias)
      await refreshAccounts($)
      return { text: alias ? t.named(alias) : t.unnamed }
    }

    if (word === 'remove') {
      const all = await refreshAccounts($)
      const target = findAccount(all.flatMap(s => (s.account ? [s.account] : [])), argument)
      if (target === undefined) return { text: t.notFound(argument) }
      if (target.id === current?.id) return { text: t.removeCurrent }
      await forget($, target.id)
      if (canSwitch) await deleteVault($, target.id)
      await refreshAccounts($)
      return { text: t.removed(labelOf(target) ?? target.id) }
    }

    const target = nextView(await read($, view), word)
    if (target === undefined) return { text: t.usage }

    await update($, view, () => target)
    await $.store.set(STORE_VIEW, target)
    return { text: t.viewChanged(target) }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const current = await read($, view)
    if (e.props.hasSurvey || current === 'hidden') {
      return next(e)
    }

    // Prefer the registry's copy of the signed-in account: an alias set in
    // another session reaches this band on the next refresh.
    const all = await read($, accounts)
    const reading = await read($, snapshot)
    const fresh = all.find(s => s.account && s.account.id === reading?.account?.id)?.account
    const t = messages(await read($, locale))

    return band({
      ui: $.ui.resolve(e),
      current: reading && fresh ? { ...reading, account: fresh } : reading,
      accounts: all,
      view: current,
      now: await read($, now),
      t,
      onSwitch: account => {
        void useAccount($, account, t).then(text => $.ui.toast(text))
      },
      onToggle: () => {
        const target = current === 'compact' ? 'expanded' : 'compact'
        void update($, view, () => target).then(() => $.store.set(STORE_VIEW, target))
      },
    })
  })
}
