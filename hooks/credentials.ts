import type { EngineInterface } from 'claude-code'

import type { Profile } from './account'
import { host } from './platform'

// Credentials only ever pass through this file. They are kept where Claude
// Code keeps its own login on the platform:
//
// - macOS: the Keychain. Claude Code's item is `Claude Code-credentials`; the
//   vault keeps one item per account under its own service (account = the
//   account id), and one more for the backup.
// - Windows: files in the config folder (~\.claude). Claude Code's item is
//   `.credentials.json`; the vault keeps one `<account id>.json` per account in
//   `bench-for-claude\` beside it, and `backup-before-switch.json`. Like Claude
//   Code's own file they are plain JSON, private through the profile folder's
//   permissions.
//
// Claude Code's item holds one JSON object: `claudeAiOauth` (the login) next
// to other entries such as `pluginSecrets`. Switching replaces `claudeAiOauth`
// alone and keeps everything else.
//
// A vault entry is a VaultEntry: the login, the profile and the alias. The
// vault is the source of truth for which accounts can be switched to: the
// plugin store is tied to how the plugin was installed, the vault is not, so a
// rename or a reinstall loses nothing. The backup is Claude Code's whole item,
// taken before every switch.
//
// On macOS values are written as hex through `security -i` on stdin, so no
// secret ever appears in a process's arguments. Nothing here logs or returns a
// token to anything but the caller.

const LIVE_SERVICE = 'Claude Code-credentials'
const VAULT_SERVICE = 'bench-for-claude'
const BACKUP_ACCOUNT = 'backup:before-switch'

const LIVE_FILE = '.credentials.json'
const VAULT_DIR = 'bench-for-claude'
const BACKUP_FILE = 'backup-before-switch.json'

export type OAuth = Record<string, unknown> & { refreshTokenExpiresAt?: number }
type LiveItem = Record<string, unknown> & { claudeAiOauth?: OAuth }

export type VaultEntry = {
  oauth: OAuth
  /** Claude Code's `oauthAccount` block for this account, written back on a switch. */
  profile?: Profile
  alias?: string
  /**
   * When this login was found revoked. Kept until a new login replaces it, so
   * a switch to the account is refused until then.
   */
  deadAt?: number
}

/**
 * Where Claude Code's item and the vault are kept on this machine. On Windows,
 * the config folder's files: Claude Code's item and the vault folder.
 */
type Place = { kind: 'keychain' } | { kind: 'files'; live: string; vault: string; join: (...parts: string[]) => string }

/** Where logins are kept, or undefined when there is no home folder to find files in. */
async function placeOf($: EngineInterface): Promise<Place | undefined> {
  const { isWindows, home, join } = await host($)
  if (!isWindows) return { kind: 'keychain' }
  if (!home) return undefined
  const configDir = join(home, '.claude')
  return { kind: 'files', live: join(configDir, LIVE_FILE), vault: join(configDir, VAULT_DIR), join }
}

// ---- macOS: the Keychain, through `security` ----

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

// ---- Windows: files in the config folder ----

async function readFile($: EngineInterface, path: string): Promise<string | undefined> {
  try {
    return await $.fs.read(path)
  } catch {
    return undefined
  }
}

async function writeFile($: EngineInterface, path: string, text: string): Promise<void> {
  await $.fs.write(path, text)
  if ((await readFile($, path)) !== text) throw new Error(`Write failed (${path})`)
}

/** A vault entry's file. Account ids are Claude Code's account UUIDs, safe as file names. */
const entryPath = (place: Extract<Place, { kind: 'files' }>, account: string): string =>
  place.join(place.vault, account === BACKUP_ACCOUNT ? BACKUP_FILE : `${account}.json`)

// ---- Either place ----

/** Whether Claude Code's item is there, without reading the secret. */
async function hasLive($: EngineInterface, place: Place): Promise<boolean> {
  if (place.kind === 'files') return $.fs.exists(place.live)
  return (await liveAccount($)) !== undefined
}

async function readLiveRaw($: EngineInterface, place: Place): Promise<string | undefined> {
  return place.kind === 'files' ? readFile($, place.live) : find($, LIVE_SERVICE)
}

async function writeLiveRaw($: EngineInterface, place: Place, raw: string): Promise<void> {
  if (place.kind === 'files') return writeFile($, place.live, raw)
  const account = await liveAccount($)
  if (account === undefined) throw new Error('No Claude Code login in the Keychain')
  await store($, LIVE_SERVICE, account, raw)
}

/** The vault entry under `account`: an account id, or the backup. */
async function readEntry($: EngineInterface, place: Place, account: string): Promise<string | undefined> {
  return place.kind === 'files' ? readFile($, entryPath(place, account)) : find($, VAULT_SERVICE, account)
}

async function writeEntry($: EngineInterface, place: Place, account: string, value: string): Promise<void> {
  if (place.kind === 'files') return writeFile($, entryPath(place, account), value)
  await store($, VAULT_SERVICE, account, value)
}

async function removeEntry($: EngineInterface, place: Place, account: string): Promise<void> {
  if (place.kind === 'keychain') {
    await $.process.run(['security', 'delete-generic-password', '-s', VAULT_SERVICE, '-a', account])
    return
  }
  // The engine has no file delete. The path goes through the environment, so
  // no quoting of it reaches PowerShell's parser.
  await $.process.run(
    ['powershell.exe', '-NoProfile', '-NonInteractive', '-Command',
      'Remove-Item -LiteralPath $env:BENCH_FOR_CLAUDE_PATH -Force -ErrorAction SilentlyContinue'],
    { env: { BENCH_FOR_CLAUDE_PATH: entryPath(place, account) } },
  )
}

/** Ids of every account in the vault, the backup left out. Reads no secret. */
async function listEntries($: EngineInterface, place: Place): Promise<string[]> {
  if (place.kind === 'files') {
    let entries: Awaited<ReturnType<EngineInterface['fs']['list']>>
    try {
      entries = await $.fs.list(place.vault)
    } catch {
      return []
    }
    return entries.flatMap(({ name, kind }) =>
      kind === 'file' && name.endsWith('.json') && name !== BACKUP_FILE ? [name.slice(0, -'.json'.length)] : [])
  }
  const { exitCode, stdout } = await $.process.run(['security', 'dump-keychain'])
  if (exitCode !== 0) return []
  return stdout.split(/^keychain: /m).flatMap(item => {
    if (!item.includes(`"svce"<blob>="${VAULT_SERVICE}"`)) return []
    const account = /"acct"<blob>="([^"]*)"/.exec(item)?.[1]
    return account && account !== BACKUP_ACCOUNT ? [account] : []
  })
}

/**
 * Whether this machine keeps the login where this mod can switch it: the macOS
 * Keychain under the default service, or the default config folder on Windows.
 * A custom CLAUDE_CONFIG_DIR moves the login elsewhere, which this version
 * does not handle yet. Elsewhere (Linux) `security` does not run, so: no.
 */
export async function isSupported($: EngineInterface): Promise<boolean> {
  if (await $.env.get('CLAUDE_CONFIG_DIR')) return false
  try {
    const place = await placeOf($)
    return place !== undefined && (await hasLive($, place))
  } catch {
    return false
  }
}

async function readLive($: EngineInterface): Promise<LiveItem | undefined> {
  const place = await placeOf($)
  const raw = place && (await readLiveRaw($, place))
  if (raw === undefined) return undefined
  try {
    return JSON.parse(raw) as LiveItem
  } catch {
    return undefined
  }
}

/** The signed-in login, or undefined when there is none. */
export async function readLiveOAuth($: EngineInterface): Promise<OAuth | undefined> {
  return (await readLive($))?.claudeAiOauth
}

export async function readVault($: EngineInterface, accountId: string): Promise<VaultEntry | undefined> {
  const place = await placeOf($)
  const raw = place && (await readEntry($, place, accountId))
  if (raw === undefined) return undefined
  try {
    const entry = JSON.parse(raw) as VaultEntry
    return entry.oauth ? entry : undefined
  } catch {
    return undefined
  }
}

async function writeVault($: EngineInterface, accountId: string, entry: VaultEntry): Promise<void> {
  const place = await placeOf($)
  if (place === undefined) throw new Error('No place to save logins on this machine')
  await writeEntry($, place, accountId, JSON.stringify(entry))
}

/** Ids of every account in the vault. */
export async function listVault($: EngineInterface): Promise<string[]> {
  const place = await placeOf($)
  return place ? listEntries($, place) : []
}

/** Keeps the alias next to the login, so it survives a reinstall. */
export async function setVaultAlias($: EngineInterface, accountId: string, alias: string | undefined): Promise<void> {
  const entry = await readVault($, accountId)
  if (entry !== undefined) await writeVault($, accountId, { ...entry, alias })
}

export async function deleteVault($: EngineInterface, accountId: string): Promise<void> {
  const place = await placeOf($)
  if (place) await removeEntry($, place, accountId)
}

/**
 * Saves the signed-in login and profile under `accountId` when they differ
 * from the vault's copy, keeping its alias. Logins rotate their refresh token,
 * so this runs on every measurement and tick. A dead mark is kept until a
 * working login with a new refresh token (a fresh /login) replaces the old one.
 * Returns the entry as saved, or undefined when there is no login to save.
 */
export async function capture(
  $: EngineInterface,
  accountId: string,
  profile: Profile,
): Promise<VaultEntry | undefined> {
  const live = await readLiveOAuth($)
  if (live === undefined) return undefined
  const saved = await readVault($, accountId)
  const { deadAt, ...rest }: Partial<VaultEntry> = saved ?? {}
  const isRenewed = !isRevoked(live) && live.refreshToken !== saved?.oauth.refreshToken
  const next: VaultEntry = { ...rest, oauth: live, profile, ...(deadAt !== undefined && !isRenewed ? { deadAt } : {}) }
  if (saved === undefined || JSON.stringify(saved) !== JSON.stringify(next)) {
    await writeVault($, accountId, next)
  }
  return next
}

/**
 * Marks the account's saved login as revoked. Returns false when it already
 * was, or when there is no login to mark, so the person is told only once.
 */
export async function markDead(
  $: EngineInterface,
  accountId: string,
  profile: Profile,
  now: number,
): Promise<boolean> {
  const saved = await readVault($, accountId)
  if (saved?.deadAt !== undefined) return false
  const oauth = saved?.oauth ?? (await readLiveOAuth($))
  if (oauth === undefined) return false
  await writeVault($, accountId, { ...saved, oauth, profile: saved?.profile ?? profile, deadAt: now })
  return true
}

/**
 * Puts `oauth` in Claude Code's item, keeping its other entries, after backing
 * the whole item up. Returns a function that puts the backup back.
 */
export async function installLive($: EngineInterface, oauth: OAuth): Promise<() => Promise<void>> {
  const place = await placeOf($)
  const raw = place && (await readLiveRaw($, place))
  if (place === undefined || raw === undefined) throw new Error('No Claude Code login to replace')

  await writeEntry($, place, BACKUP_ACCOUNT, raw)
  const item = JSON.parse(raw) as LiveItem
  await writeLiveRaw($, place, JSON.stringify({ ...item, claudeAiOauth: oauth }))

  return async () => writeLiveRaw($, place, raw)
}

/**
 * Whether Claude Code gave up on this login. When a refresh is refused
 * (`invalid_grant`: signed out on claude.ai, or revoked), Claude Code empties
 * the tokens in its item; a login that hit its time limit also carries
 * `loginEnded`.
 */
export const isRevoked = (oauth: OAuth): boolean =>
  oauth.refreshToken === '' || oauth.loginEnded !== undefined

/**
 * Whether a saved login can be switched to. `expired`: its refresh token's
 * lifetime is over. `revoked`: Claude Code found it refused, or it was marked
 * dead. Either way the account needs a fresh /login.
 */
export const loginState = (entry: VaultEntry, now: number): 'ok' | 'expired' | 'revoked' => {
  const expiresAt = entry.oauth.refreshTokenExpiresAt
  if (typeof expiresAt === 'number' && expiresAt <= now) return 'expired'
  if (entry.deadAt !== undefined || isRevoked(entry.oauth)) return 'revoked'
  return 'ok'
}
