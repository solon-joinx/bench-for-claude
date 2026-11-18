/** One rate-limit window as the engine reports it (`five_hour`, `seven_day`, ...). */
export type UsageWindow = {
  kind: string
  percentUsed: number
  /** ISO 8601 timestamp of the next reset, when known. */
  resetsAt?: string
  /**
   * Set when a request was refused for this window's limit. The last reading
   * before the refusal can sit below 100%, since a refused request reports none.
   */
  isExhausted?: boolean
}

/** The signed-in account, as read from Claude Code's global config. No secrets. */
export type Account = {
  /** Stable id (`accountUuid`); used as the storage key for snapshots. */
  id: string
  email?: string
  name?: string
  /** Human-readable plan, e.g. `Pro`, `Max 20x`. */
  plan?: string
  /** A short name the user gave this account (`/accounts name work`). */
  alias?: string
}

/** The last usage reading of one account. */
export type Snapshot = {
  account: Account | null
  windows: UsageWindow[]
  /** Epoch milliseconds of the reading. */
  measuredAt: number
}

export type BandView = 'compact' | 'expanded' | 'hidden'

export type Locale = 'en' | 'zh-TW'

declare module 'claude-code' {
  interface PluginState {
    'bench-for-claude': {
      /** The signed-in account's reading. */
      snapshot: Snapshot | null
      /** Every known account's last reading, the signed-in one included. */
      accounts: Snapshot[]
      view: BandView
      locale: Locale
      /** Wall clock, ticked once a minute so countdowns redraw. */
      now: number
      /** Id of the account this session started with; survives reloads. */
      sessionAccount: string | null
    }
  }
}
