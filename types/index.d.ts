export type CacheWatchTurn = { read: number; written: number; isHit: boolean }

export type FableReading = { percentUsed: number | null; resetsAt: string | null; error: string | null }

declare module 'claude-code' {
  interface PluginState {
    'cache-watch': {
      lastCallAt: number | null
      lastModel: string | null
      contextTokens: number | null
      lastTurn: CacheWatchTurn | null
      ttlMinutes: number
      forcedColdReason: string | null
      tick: number
      isHidden: boolean
      keepWarmUntil: number | null
      fable: FableReading | null
    }
  }
}
