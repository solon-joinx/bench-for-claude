import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'


const NOW = Date.parse('2026-11-18T12:00:00Z')
const LIVE = 'Claude Code-credentials'
const VAULT = 'bench-for-claude'
const CONFIG = '/home/me/.claude.json'

const WIN_HOME = 'C:\\Users\\me'
const WIN_CONFIG = `${WIN_HOME}\\.claude.json`
const WIN_LIVE = `${WIN_HOME}\\.claude\\.credentials.json`
const WIN_VAULT = `${WIN_HOME}\\.claude\\bench-for-claude`

const WORK = { id: 'acc-work', email: 'me@work.example' }
const HOME = { id: 'acc-home', email: 'me@home.example', alias: 'home' }

const login = (name: string, refreshTokenExpiresAt = NOW + 86_400_000) =>
  ({ accessToken: `access-${name}`, refreshToken: `refresh-${name}`, refreshTokenExpiresAt })
const profile = (account: { id: string; email: string }) =>
  ({ accountUuid: account.id, emailAddress: account.email, organizationType: 'claude_pro' })

const unhex = (hex: string) => decodeURIComponent(hex.replace(/../g, '%$&'))

/** A fake Keychain, global config and store behind the engine calls the mod makes. */
const machine = (on: On, options: { failConfigWrite?: boolean; view?: string; windows?: boolean } = {}) => {
  const keychain = new Map<string, string>()
  const files = new Map<string, string>()
  const store = new Map<string, unknown>()
  const commands: (readonly string[])[] = []

  const env: Record<string, string> = options.windows
    ? { OS: 'Windows_NT', USERPROFILE: WIN_HOME }
    : { HOME: '/home/me' }
  on('env.get', (_, e) => ({ value: env[e.name] }))
  on('clock.now', () => ({ value: NOW }))
  on('store.get', (_, e) => ({ value: store.get(e.key) }))
  on('store.set', (_, e) => (store.set(e.key, e.value), { value: undefined }))
  on('store.delete', (_, e) => (store.delete(e.key), { value: undefined }))
  // Windows-side calls answer as the real ones do: a missing file rejects. On
  // the macOS host the tests run on, the engine reads `C:\\...` as relative and
  // puts the working directory in front; take it off again.
  const at = (path: string) => (options.windows ? path.slice(path.indexOf(WIN_HOME)) : path)
  on('fs.read', (_, e) => {
    const text = files.get(at(e.path))
    if (text === undefined && options.windows) return { deny: 'ENOENT' }
    return { value: text ?? '' }
  })
  on('fs.exists', (_, e) => ({ value: files.has(at(e.path)) }))
  on('fs.list', (_, e) => ({
    value: [...files.keys()]
      .filter(path => path.startsWith(`${at(e.path)}\\`))
      .map(path => ({ name: path.slice(at(e.path).length + 1), kind: 'file', size: 0, mtimeMs: 0, isLink: false })),
  }))
  on('fs.write', (_, e) => {
    if (options.failConfigWrite && e.path.endsWith('.claude.json')) return { deny: 'disk full' }
    files.set(at(e.path), e.text)
    return { value: undefined }
  })
  // Session state: the signed-in account is WORK; both accounts are known.
  const state = new Map<string, unknown>([
    ['snapshot', { account: WORK, windows: [], measuredAt: 0 }],
    ['accounts', [{ account: WORK, windows: [], measuredAt: 0 }, { account: HOME, windows: [], measuredAt: 0 }]],
    ['locale', 'en'],
    ['view', options.view ?? 'compact'],
    ['now', NOW],
  ])
  on('state.get', (_, e) => ({
    value: state.has(e.key) ? { value: state.get(e.key), version: 1 } : { value: undefined, version: 0 },
  }))
  on('state.set', (_, e) => (state.set(e.key, e.value), { value: { isSet: true, version: 2 } }))
  const toasts: string[] = []
  on('ui.toast', (_, e) => (toasts.push(String(e.text)), { value: undefined }))
  on('process.run', (_, e) => {
    const [command, sub, ...args] = e.argv
    const flag = (name: string) => args[args.indexOf(name) + 1]
    const result = (exitCode: number, stdout = '') =>
      ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    const ok = (stdout = '') => result(0, stdout)
    const missing = result(44)
    commands.push(e.argv)

    if (command === 'chmod') return ok()
    if (command === 'powershell.exe') {
      files.delete(e.init?.env?.BENCH_FOR_CLAUDE_PATH ?? '')
      return ok()
    }
    if (sub === 'find-generic-password') {
      const service = flag('-s')!
      const account = args.includes('-a') ? flag('-a') : service === LIVE ? 'me' : undefined
      const value = keychain.get(`${service}|${account}`)
      if (value === undefined) return missing
      return args.includes('-w') ? ok(`${value}\n`) : ok(`    "acct"<blob>="${account}"\n`)
    }
    if (sub === 'delete-generic-password') {
      keychain.delete(`${flag('-s')}|${flag('-a')}`)
      return ok()
    }
    if (sub === '-i') {
      const line = String(e.init?.stdin ?? '')
      const [, account, service, hex] = /-a "([^"]*)" -s "([^"]*)" -X ([0-9a-f]+)/.exec(line)!
      keychain.set(`${service}|${account}`, unhex(hex!))
      return ok()
    }
    return missing
  })

  // The registry knows both accounts.
  store.set('accounts', { [WORK.id]: WORK, [HOME.id]: HOME })

  return { keychain, files, store, state, toasts, commands }
}

/** Runs `/accounts <args>` and returns what it printed; the engine fills origin and presentation. */
const run = async ($: Engine, args: string) =>
  (await $.command.run({ command: 'accounts', args } as Parameters<Engine['command']['run']>[0])).text ?? ''

test('switching swaps the login, keeps other Keychain entries, and saves the outgoing login', async ($, on) => {
  const { keychain, files, store } = machine(on)
  const pluginSecrets = { 'other@market': { token: 'keep-me' } }
  keychain.set(`${LIVE}|me`, JSON.stringify({ claudeAiOauth: login('work-new'), pluginSecrets }))
  keychain.set(`${VAULT}|${WORK.id}`, JSON.stringify({ oauth: login('work-old'), profile: profile(WORK) }))
  keychain.set(`${VAULT}|${HOME.id}`, JSON.stringify({ oauth: login('home'), profile: profile(HOME) }))
  files.set(CONFIG, JSON.stringify({ numStartups: 3, oauthAccount: profile(WORK) }, null, 2))

  expect(await run($, 'use home')).toMatch(/^Switched to home/)

  const live = JSON.parse(keychain.get(`${LIVE}|me`)!)
  expect(live.claudeAiOauth.refreshToken).toBe('refresh-home')
  expect(live.pluginSecrets).toEqual(pluginSecrets)
  // The outgoing account's rotated login replaced its older copy.
  expect(JSON.parse(keychain.get(`${VAULT}|${WORK.id}`)!).oauth.refreshToken).toBe('refresh-work-new')

  const config = JSON.parse(files.get(CONFIG)!)
  expect(config.oauthAccount.accountUuid).toBe(HOME.id)
  expect(config.numStartups).toBe(3)
  expect(store.has('switchingUntil')).toBe(false)
  expect(store.get('switchedAt')).toBe(NOW)
})

test('a failed config write puts the Keychain item back', async ($, on) => {
  const { keychain, files, store } = machine(on, { failConfigWrite: true })
  const original = JSON.stringify({ claudeAiOauth: login('work') })
  keychain.set(`${LIVE}|me`, original)
  keychain.set(`${VAULT}|${HOME.id}`, JSON.stringify({ oauth: login('home'), profile: profile(HOME) }))
  files.set(CONFIG, JSON.stringify({ oauthAccount: profile(WORK) }))

  expect(await run($, 'use home')).toMatch(/^Switch failed/)
  expect(keychain.get(`${LIVE}|me`)).toBe(original)
  expect(store.has('switchingUntil')).toBe(false)
})

test('an account with no saved login, or an expired one, is refused untouched', async ($, on) => {
  const { keychain, files, store } = machine(on)
  const original = JSON.stringify({ claudeAiOauth: login('work') })
  keychain.set(`${LIVE}|me`, original)
  files.set(CONFIG, JSON.stringify({ oauthAccount: profile(WORK) }))

  expect(await run($, 'use home')).toMatch(/no saved login/)

  keychain.set(`${VAULT}|${HOME.id}`, JSON.stringify({ oauth: login('home', NOW - 1), profile: profile(HOME) }))
  expect(await run($, 'use home')).toMatch(/has expired/)

  expect(await run($, 'use me@work.example')).toMatch(/already signed in/)
  expect(keychain.get(`${LIVE}|me`)).toBe(original)
})

test('on Windows, switching swaps the login in the credentials file and keeps the vault in files', async ($, on) => {
  const { files, store, commands } = machine(on, { windows: true })
  const pluginSecrets = { 'other@market': { token: 'keep-me' } }
  const original = JSON.stringify({ claudeAiOauth: login('work-new'), pluginSecrets })
  files.set(WIN_LIVE, original)
  files.set(`${WIN_VAULT}\\${WORK.id}.json`, JSON.stringify({ oauth: login('work-old'), profile: profile(WORK) }))
  files.set(`${WIN_VAULT}\\${HOME.id}.json`, JSON.stringify({ oauth: login('home'), profile: profile(HOME) }))
  files.set(WIN_CONFIG, JSON.stringify({ numStartups: 3, oauthAccount: profile(WORK) }, null, 2))

  expect(await run($, 'use home')).toMatch(/^Switched to home/)

  const live = JSON.parse(files.get(WIN_LIVE)!)
  expect(live.claudeAiOauth.refreshToken).toBe('refresh-home')
  expect(live.pluginSecrets).toEqual(pluginSecrets)
  expect(files.get(`${WIN_VAULT}\\backup-before-switch.json`)).toBe(original)
  expect(JSON.parse(files.get(`${WIN_VAULT}\\${WORK.id}.json`)!).oauth.refreshToken).toBe('refresh-work-new')

  const config = JSON.parse(files.get(WIN_CONFIG)!)
  expect(config.oauthAccount.accountUuid).toBe(HOME.id)
  expect(config.numStartups).toBe(3)
  expect(store.get('switchedAt')).toBe(NOW)
  // Nothing macOS-only ran.
  expect(commands.some(argv => argv[0] === 'security' || argv[0] === 'chmod')).toBe(false)
})

test('on Windows, a failed config write puts the credentials file back', async ($, on) => {
  const { files } = machine(on, { windows: true, failConfigWrite: true })
  const original = JSON.stringify({ claudeAiOauth: login('work') })
  files.set(WIN_LIVE, original)
  files.set(`${WIN_VAULT}\\${HOME.id}.json`, JSON.stringify({ oauth: login('home'), profile: profile(HOME) }))
  files.set(WIN_CONFIG, JSON.stringify({ oauthAccount: profile(WORK) }))

  expect(await run($, 'use home')).toMatch(/^Switch failed/)
  expect(files.get(WIN_LIVE)).toBe(original)
})

test('on Windows, with no credentials file, switching is unsupported', async ($, on) => {
  const { files } = machine(on, { windows: true })
  files.set(`${WIN_VAULT}\\${HOME.id}.json`, JSON.stringify({ oauth: login('home'), profile: profile(HOME) }))
  files.set(WIN_CONFIG, JSON.stringify({ oauthAccount: profile(WORK) }))

  expect(await run($, 'use home')).toMatch(/needs macOS or Windows/)
})

test('on Windows, the vault is listed from its folder and an entry removed through PowerShell', async ($, on) => {
  const { files, store } = machine(on, { windows: true })
  files.set(WIN_LIVE, JSON.stringify({ claudeAiOauth: login('work') }))
  files.set(`${WIN_VAULT}\\${HOME.id}.json`, JSON.stringify({ oauth: login('home'), profile: profile(HOME), alias: 'home' }))
  files.set(`${WIN_VAULT}\\backup-before-switch.json`, '{}')
  files.set(WIN_CONFIG, JSON.stringify({ oauthAccount: profile(WORK) }))
  store.set('accounts', { [WORK.id]: WORK })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('settings.read', () => ({ value: {} }))

  await $.session.start({ cwd: WIN_HOME } as Parameters<Engine['session']['start']>[0])
  expect(Object.keys(store.get('accounts') as object).sort()).toEqual([HOME.id, WORK.id].sort())

  expect(await run($, 'remove home')).toMatch(/home/)
  expect(files.has(`${WIN_VAULT}\\${HOME.id}.json`)).toBe(false)
  expect(files.has(`${WIN_VAULT}\\backup-before-switch.json`)).toBe(true)
})

/** Raises one rate-limit measurement, as the engine does after a reply. */
const measure = ($: Engine, percentUsed: number) =>
  $.session.measure({
    context: {},
    rateLimits: [{ kind: 'five_hour', percentUsed }],
    changed: ['rateLimits'],
  } as unknown as Parameters<Engine['session']['measure']>[0])

test('readings right after a switch are not recorded, later ones are', async ($, on) => {
  const { files, store } = machine(on)
  on('session.measure', (_, e) => ({ changed: e.changed }))
  files.set(CONFIG, JSON.stringify({ oauthAccount: profile(HOME) }))

  // A session may still send the old login until Claude Code reads it again.
  store.set('switchedAt', NOW - 10_000)
  await measure($, 40)
  expect(store.has(`snapshot:${HOME.id}`)).toBe(false)

  store.set('switchedAt', NOW - 60_000)
  await measure($, 40)
  expect((store.get(`snapshot:${HOME.id}`) as { windows: { percentUsed: number }[] }).windows[0]?.percentUsed).toBe(40)
})

const BAND = {
  plugin: 'bench-for-claude',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 8, bodyColumns: 100, scroll: { offset: 0, bodyRows: 8 }, view: {} },
} as const

/** Lets a press's fire-and-forget work settle. */
const settle = async (until: () => boolean) => {
  for (let i = 0; i < 2000 && !until(); i++) await Promise.resolve()
}

test('the expanded band\'s Switch button switches accounts', async ($, on) => {
  const { keychain, files, store, toasts } = machine(on, { view: 'expanded' })
  keychain.set(`${LIVE}|me`, JSON.stringify({ claudeAiOauth: login('work') }))
  keychain.set(`${VAULT}|${HOME.id}`, JSON.stringify({ oauth: login('home'), profile: profile(HOME) }))
  files.set(CONFIG, JSON.stringify({ oauthAccount: profile(WORK) }))

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await ui.press({ key: `use-${HOME.id}` })
  await settle(() => toasts.length > 0)

  expect(toasts[0]).toMatch(/^Switched to home/)
  expect(JSON.parse(keychain.get(`${LIVE}|me`)!).claudeAiOauth.refreshToken).toBe('refresh-home')
  await ui.unmount()
})

test('the toggle button expands a compact band and collapses an expanded one', async ($, on) => {
  const { state, store } = machine(on)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ key: `use-${HOME.id}` })).toBeFalsy()
  await ui.press({ key: 'toggle' })
  await settle(() => store.get('view') === 'expanded')
  expect(state.get('view')).toBe('expanded')
  await ui.unmount()

  const expanded = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await expanded.find({ key: `use-${HOME.id}` })).toBeTruthy()
  await expanded.press({ key: 'toggle' })
  await settle(() => store.get('view') === 'compact')
  expect(state.get('view')).toBe('compact')
  await expanded.unmount()
})
