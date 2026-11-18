import type { EngineInterface } from 'claude-code'

import type { Profile } from './account'

// Credentials live in the macOS Keychain and only ever pass through this file.
//
// Claude Code's own item (`Claude Code-credentials`) holds one JSON object:
// `claudeAiOauth` (the login) next to other entries such as `pluginSecrets`.
// Switching replaces `claudeAiOauth` alone and keeps everything else.
//
// The vault keeps one item per account under its own service (account = the
// account id), holding a VaultEntry: the login, the profile and the alias.
// It is the source of truth for which accounts can be switched to: the
// plugin store is tied to how the plugin was installed, the Keychain is not,
// so a rename or a reinstall loses nothing. One more item holds a backup of
// Claude Code's whole item, taken before every switch.
//
// Values are written as hex through `security -i` on stdin, so no secret ever
// appears in a process's arguments. Nothing here logs or returns a token to
// anything but the caller.

const LIVE_SERVICE = 'Claude Code-credentials'
const VAULT_SERVICE = 'bench-for-claude'
const BACKUP_ACCOUNT = 'backup:before-switch'

export type OAuth = Record<string, unknown> & { refreshTokenExpiresAt?: number }
type LiveItem = Record<string, unknown> & { claudeAiOauth?: OAuth }

export type VaultEntry = {
  oauth: OAuth
  /** Claude Code's `oauthAccount` block for this account, written back on a switch. */
  profile?: Profile
  alias?: string
}

/** UTF-8 bytes of `text` as hex, without TextEncoder (the hooks runtime has no DOM or Node). */
const hex = (text: string): string =>
  encodeURIComponent(text).replace(/%([0-9A-F]{2})|[^%]/g, (char, byte?: string) =>
    byte ? byte.toLowerCase() : char.charCodeAt(0).toString(16).padStart(2, '0'))

/** `security -w` prints non-ASCII data as hex; turn it back into text. */
const fromSecurity = (output: string): string => {
  const text = output.trim()
  if (text.startsWith('{') || !/^([0-9a-f]{2})+$/.test(text)) return text
  return decodeURIComponent(text.replace(/../g, '%$&'))
}

async function find($: EngineInterface, service: string, account?: string): Promise<string | undefined> {
  const argv = ['security', 'find-generic-password', '-s', service, ...(account ? ['-a', account] : []), '-w']
  const { exitCode, stdout } = await $.process.run(argv)
  return exitCode === 0 ? fromSecurity(stdout) : undefined
}

async function store($: EngineInterface, service: string, account: string, value: string): Promise<void> {
  const quoted = (word: string) => `"${word.replace(/["\\]/g, '\\$&')}"`
  const line = `add-generic-password -U -a ${quoted(account)} -s ${quoted(service)} -X ${hex(value)}\n`
  await $.process.run(['security', '-i'], { stdin: line })
  // `security -i` exits 0 even when a command fails: read the value back.
  if ((await find($, service, account)) !== value) {
    throw new Error(`Keychain write failed (${service})`)
  }
}

/** The Keychain account Claude Code filed its item under, read off the item. */
async function liveAccount($: EngineInterface): Promise<string | undefined> {
  const { exitCode, stdout } = await $.process.run(['security', 'find-generic-password', '-s', LIVE_SERVICE])
  return exitCode === 0 ? /"acct"<blob>="([^"]*)"/.exec(stdout)?.[1] : undefined
}

/**
 * Whether this machine keeps the login where this mod can switch it: the macOS
 * Keychain under the default service. A custom CLAUDE_CONFIG_DIR files it under
 * another service name, which this version does not handle yet.
 */
export async function isSupported($: EngineInterface): Promise<boolean> {
  if (await $.env.get('CLAUDE_CONFIG_DIR')) return false
  try {
    return (await liveAccount($)) !== undefined
  } catch {
    return false
  }
}

async function readLive($: EngineInterface): Promise<LiveItem | undefined> {
  const raw = await find($, LIVE_SERVICE)
  if (raw === undefined) return undefined
  try {
    return JSON.parse(raw) as LiveItem
  } catch {
    return undefined
  }
}

/** The signed-in login, or undefined when there is none in the Keychain. */
export async function readLiveOAuth($: EngineInterface): Promise<OAuth | undefined> {
  return (await readLive($))?.claudeAiOauth
}

export async function readVault($: EngineInterface, accountId: string): Promise<VaultEntry | undefined> {
  const raw = await find($, VAULT_SERVICE, accountId)
  if (raw === undefined) return undefined
  try {
    const entry = JSON.parse(raw) as VaultEntry
    return entry.oauth ? entry : undefined
  } catch {
    return undefined
  }
}

async function writeVault($: EngineInterface, accountId: string, entry: VaultEntry): Promise<void> {
  await store($, VAULT_SERVICE, accountId, JSON.stringify(entry))
}

/** Ids of every account in the vault. Reads item attributes only, never their data. */
export async function listVault($: EngineInterface): Promise<string[]> {
  const { exitCode, stdout } = await $.process.run(['security', 'dump-keychain'])
  if (exitCode !== 0) return []
  return stdout.split(/^keychain: /m).flatMap(item => {
    if (!item.includes(`"svce"<blob>="${VAULT_SERVICE}"`)) return []
    const account = /"acct"<blob>="([^"]*)"/.exec(item)?.[1]
    return account && account !== BACKUP_ACCOUNT ? [account] : []
  })
}

/** Keeps the alias next to the login, so it survives a reinstall. */
export async function setVaultAlias($: EngineInterface, accountId: string, alias: string | undefined): Promise<void> {
  const entry = await readVault($, accountId)
  if (entry !== undefined) await writeVault($, accountId, { ...entry, alias })
}

export async function deleteVault($: EngineInterface, accountId: string): Promise<void> {
  await $.process.run(['security', 'delete-generic-password', '-s', VAULT_SERVICE, '-a', accountId])
}

/**
 * Saves the signed-in login and profile under `accountId` when they differ
 * from the vault's copy, keeping its alias. Logins rotate their refresh token,
 * so this runs on every measurement and tick.
 */
export async function capture($: EngineInterface, accountId: string, profile: Profile): Promise<void> {
  const live = await readLiveOAuth($)
  if (live === undefined) return
  const saved = await readVault($, accountId)
  const next: VaultEntry = { ...saved, oauth: live, profile }
  if (saved === undefined || JSON.stringify(saved) !== JSON.stringify(next)) {
    await writeVault($, accountId, next)
  }
}

/**
 * Puts `oauth` in Claude Code's item, keeping its other entries, after backing
 * the whole item up. Returns a function that puts the backup back.
 */
export async function installLive($: EngineInterface, oauth: OAuth): Promise<() => Promise<void>> {
  const account = await liveAccount($)
  const raw = await find($, LIVE_SERVICE)
  if (account === undefined || raw === undefined) throw new Error('No Claude Code login in the Keychain')

  await store($, VAULT_SERVICE, BACKUP_ACCOUNT, raw)
  const item = JSON.parse(raw) as LiveItem
  await store($, LIVE_SERVICE, account, JSON.stringify({ ...item, claudeAiOauth: oauth }))

  return async () => store($, LIVE_SERVICE, account, raw)
}

/** A saved login whose refresh token has expired needs a fresh /login. */
export const isExpired = (oauth: OAuth, now: number): boolean =>
  typeof oauth.refreshTokenExpiresAt === 'number' && oauth.refreshTokenExpiresAt <= now
