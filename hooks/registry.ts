import type { EngineInterface } from 'claude-code'

import type { Account, Snapshot } from '../types'

// Store layout ($.store is per plugin, shared by every session, kept across sessions):
//   accounts        Record<accountId, Account>   every account seen, with its alias
//   snapshot:<id>   Snapshot                     that account's last usage reading
// The store is a cache: it belongs to one installation of the plugin. Logins,
// profiles and aliases are kept in the Keychain vault (credentials.ts), and the
// registry is rebuilt from it at session start.
const ACCOUNTS = 'accounts'
const snapshotKey = (id: string) => `snapshot:${id}`

type Registry = Record<string, Account>

export async function loadRegistry($: EngineInterface): Promise<Registry> {
  const value = await $.store.get(ACCOUNTS)
  return value && typeof value === 'object' ? (value as Registry) : {}
}

/** Adds or refreshes an account's profile, keeping the alias it was given. */
export async function remember($: EngineInterface, account: Account): Promise<Account> {
  const registry = await loadRegistry($)
  const merged: Account = { ...account, alias: registry[account.id]?.alias ?? account.alias }
  await $.store.set(ACCOUNTS, { ...registry, [account.id]: merged })
  return merged
}

export async function setAlias($: EngineInterface, id: string, alias: string | undefined): Promise<void> {
  const registry = await loadRegistry($)
  const account = registry[id]
  if (account === undefined) return
  await $.store.set(ACCOUNTS, { ...registry, [id]: { ...account, alias } })
}

export async function forget($: EngineInterface, id: string): Promise<void> {
  const { [id]: _, ...rest } = await loadRegistry($)
  await $.store.set(ACCOUNTS, rest)
  await $.store.delete(snapshotKey(id))
}

export async function saveSnapshot($: EngineInterface, snapshot: Snapshot): Promise<void> {
  if (snapshot.account) await $.store.set(snapshotKey(snapshot.account.id), snapshot)
}

export async function loadSnapshot($: EngineInterface, id: string): Promise<Snapshot | undefined> {
  return (await $.store.get(snapshotKey(id))) as Snapshot | undefined
}

/** Every known account with its last reading (empty windows when never measured). */
export async function loadAll($: EngineInterface): Promise<Snapshot[]> {
  const registry = await loadRegistry($)
  const all: Snapshot[] = []
  for (const account of Object.values(registry)) {
    const stored = await loadSnapshot($, account.id)
    all.push({ windows: [], measuredAt: 0, ...stored, account })
  }
  return all
}

/** What the band and messages call an account: alias, else email, else name. */
export const labelOf = (account: Account): string | undefined =>
  account.alias ?? account.email ?? account.name

/** Finds an account by alias, email or name, case-insensitively. */
export const findAccount = (accounts: readonly Account[], query: string): Account | undefined => {
  const wanted = query.trim().toLowerCase()
  return accounts.find(account =>
    [account.alias, account.email, account.name].some(field => field?.toLowerCase() === wanted))
}
