import type { EngineInterface } from 'claude-code'

import type { Account } from '../types'

import { host } from './platform'

const PLANS: Record<string, string> = {
  claude_pro: 'Pro',
  claude_max: 'Max',
  claude_team: 'Team',
  claude_enterprise: 'Enterprise',
}

/** `default_claude_max_20x` -> `20x`. */
const multiplier = (tier: unknown): string | undefined =>
  typeof tier === 'string' ? /(\d+x)$/.exec(tier)?.[1] : undefined

const plan = (oauth: Record<string, unknown>): string | undefined => {
  const base = typeof oauth.organizationType === 'string' ? PLANS[oauth.organizationType] : undefined
  if (base === undefined) return undefined
  const extra = multiplier(oauth.userRateLimitTier) ?? multiplier(oauth.organizationRateLimitTier)
  return extra ? `${base} ${extra}` : base
}

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value !== '' ? value : undefined

/** Claude Code keeps its global config beside CLAUDE_CONFIG_DIR, else in the home folder. */
async function configPath($: EngineInterface): Promise<string | undefined> {
  const { home, join } = await host($)
  const dir = await $.env.get('CLAUDE_CONFIG_DIR')
  if (dir) return join(dir, '.claude.json')
  return home ? join(home, '.claude.json') : undefined
}

export type Profile = Record<string, unknown>

/** Claude Code's `oauthAccount` block as it stands: profile data, no secrets. */
export async function readProfile($: EngineInterface): Promise<Profile | undefined> {
  const path = await configPath($)
  if (path === undefined) return undefined
  try {
    const config = JSON.parse(await $.fs.read(path)) as { oauthAccount?: Profile }
    return config.oauthAccount
  } catch {
    return undefined
  }
}

/** The short form of a profile the band and the store use. */
export const toAccount = (profile: Profile | undefined): Account | null => {
  const id = text(profile?.accountUuid)
  if (profile === undefined || id === undefined) return null
  return {
    id,
    email: text(profile.emailAddress),
    name: text(profile.displayName) ?? text(profile.organizationName),
    plan: plan(profile),
  }
}

/**
 * The account the session is signed in with, from the global config's
 * `oauthAccount`. Null when signed in some other way.
 */
export async function readAccount($: EngineInterface): Promise<Account | null> {
  return toAccount(await readProfile($))
}

/**
 * Replaces `oauthAccount` in the global config and leaves every other key as
 * it was. Claude Code writes this file too, so it is read and written back in
 * one short step, in the file's own formatting (two-space JSON).
 */
export async function writeProfile($: EngineInterface, profile: Profile): Promise<void> {
  const path = await configPath($)
  if (path === undefined) throw new Error('No global config path')
  const config = JSON.parse(await $.fs.read(path)) as Record<string, unknown>
  await $.fs.write(path, JSON.stringify({ ...config, oauthAccount: profile }, null, 2))
  // The file is private to the user; keep it so whatever the write did. On
  // Windows the profile folder's own permissions already keep it private.
  if (!(await host($)).isWindows) await $.process.run(['chmod', '600', path])
}
