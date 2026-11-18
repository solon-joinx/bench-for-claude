import type { BandView, Locale } from '../types'

// To add a language: add it to `Locale` in types/index.d.ts, add a table
// below, list it in `userConfig.language.options`, and teach `fromSetting`
// how Claude Code's free-text `language` setting spells it.

const en = {
  window: (kind: string) =>
    ({ five_hour: '5h', seven_day: '7d', seven_day_opus: '7d Opus', seven_day_sonnet: '7d Sonnet' })[kind] ?? kind,
  duration: (d: number, h: number, m: number) =>
    d > 0 ? `${d}d${h ? `${h}h` : ''}` : h > 0 ? `${h}h${m ? `${m}m` : ''}` : `${m}m`,
  reset: 'reset',
  exhausted: 'limit reached',
  ago: (span: string) => `${span} ago`,
  waiting: 'Usage appears after the first reply',
  unknownAccount: 'Unknown account',
  commandDescription: 'Account usage band: layout, aliases and the list of known accounts',
  viewChanged: (view: BandView) =>
    ({ compact: 'Usage band: compact', expanded: 'Usage band: expanded', hidden: 'Usage band hidden' })[view],
  nearLimit: (window: string, percent: number) => `${window} usage at ${percent}%`,
  noData: 'no data yet',
  usage: '/accounts [compact | expanded | hide | show]  ·  use <account>  ·  name <alias>  ·  remove <account>  ·  list',
  notSignedIn: 'Not signed in with a Claude subscription account',
  named: (label: string) => `This account is now called "${label}"`,
  unnamed: 'Alias cleared',
  removed: (label: string) => `Forgot ${label}`,
  notFound: (query: string) => `No account matches "${query}"`,
  removeCurrent: 'The signed-in account is tracked automatically; sign in with another account first',
  listEmpty: 'No accounts recorded yet',
  switchButton: 'Switch',
  expandButton: 'Expand',
  collapseButton: 'Collapse',
  switched: (label: string) =>
    `Switched to ${label}. New sessions use it right away; running sessions pick it up when they next reload their login.`,
  alreadyCurrent: (label: string) => `${label} is already signed in`,
  notCaptured: (label: string) =>
    `${label} has no saved login yet: sign in with it once (/login) while this mod is enabled`,
  loginExpired: (label: string) => `The saved login for ${label} has expired: sign in with it again (/login)`,
  switchUnsupported:
    'Switching needs the macOS Keychain and the default config folder (CLAUDE_CONFIG_DIR is not supported yet)',
  switchFailed: (detail: string) => `Switch failed and the login was left as it was: ${detail}`,
}

export type Messages = typeof en

const zhTW: Messages = {
  window: (kind: string) =>
    ({ five_hour: '5h', seven_day: '7d', seven_day_opus: '7d Opus', seven_day_sonnet: '7d Sonnet' })[kind] ?? kind,
  duration: (d: number, h: number, m: number) =>
    d > 0 ? `${d}天${h ? `${h}時` : ''}` : h > 0 ? `${h}時${m ? `${m}分` : ''}` : `${m}分`,
  reset: '已重置',
  exhausted: '已用完',
  ago: (span: string) => `${span}前`,
  waiting: '第一次回覆後顯示額度',
  unknownAccount: '未知帳號',
  commandDescription: '帳號額度列：版面、別名與已記錄的帳號',
  viewChanged: (view: BandView) =>
    ({ compact: '額度列：精簡', expanded: '額度列：展開', hidden: '額度列已隱藏' })[view],
  nearLimit: (window: string, percent: number) => `${window} 額度已用 ${percent}%`,
  noData: '尚無資料',
  usage: '/accounts [compact | expanded | hide | show]  ·  use <帳號>  ·  name <別名>  ·  remove <帳號>  ·  list',
  notSignedIn: '目前不是以 Claude 訂閱帳號登入',
  named: (label: string) => `此帳號已命名為「${label}」`,
  unnamed: '已清除別名',
  removed: (label: string) => `已移除 ${label}`,
  notFound: (query: string) => `找不到符合「${query}」的帳號`,
  removeCurrent: '目前登入的帳號會自動記錄，請先登入其他帳號再移除',
  listEmpty: '尚未記錄任何帳號',
  switchButton: '切換',
  expandButton: '展開',
  collapseButton: '收合',
  switched: (label: string) =>
    `已切換到 ${label}。新開的 session 會立即使用；執行中的 session 會在下次重新讀取登入資訊時套用。`,
  alreadyCurrent: (label: string) => `${label} 已經是目前登入的帳號`,
  notCaptured: (label: string) => `${label} 還沒有儲存的登入資訊：請在啟用此 mod 時用它登入一次（/login）`,
  loginExpired: (label: string) => `${label} 儲存的登入已過期：請用它重新登入（/login）`,
  switchUnsupported: '切換需要 macOS Keychain 與預設設定資料夾（尚不支援 CLAUDE_CONFIG_DIR）',
  switchFailed: (detail: string) => `切換失敗，登入狀態維持原樣：${detail}`,
}

const TABLES: Record<Locale, Messages> = { en, 'zh-TW': zhTW }

export const messages = (locale: Locale): Messages => TABLES[locale]

/** Maps Claude Code's free-text `language` setting to a supported locale. */
const fromSetting = (value: unknown): Locale | undefined => {
  if (typeof value !== 'string') return undefined
  const text = value.trim().toLowerCase()
  if (/zh[-_]?(tw|hant|hk)|traditional|繁|台灣|臺灣|正體/.test(text)) return 'zh-TW'
  if (/^en\b|english/.test(text)) return 'en'
  return undefined
}

/**
 * The plugin option wins unless it is `auto`; then Claude Code's `language`
 * setting; then English.
 */
export const resolveLocale = (option: unknown, setting: unknown): Locale => {
  if (option === 'en' || option === 'zh-TW') return option
  return fromSetting(setting) ?? 'en'
}
