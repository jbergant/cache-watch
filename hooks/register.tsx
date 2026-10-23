import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { CacheWatchTurn, FableReading } from '../types'

type $ = EngineInterface

const lastCallAt = atom({ plugin: 'cache-watch', key: 'lastCallAt' } as const, null)
const lastModel = atom({ plugin: 'cache-watch', key: 'lastModel' } as const, null)
const contextTokens = atom({ plugin: 'cache-watch', key: 'contextTokens' } as const, null)
const lastTurn = atom({ plugin: 'cache-watch', key: 'lastTurn' } as const, null)
const ttlMinutes = atom({ plugin: 'cache-watch', key: 'ttlMinutes' } as const, 60)
const forcedColdReason = atom({ plugin: 'cache-watch', key: 'forcedColdReason' } as const, null)
const tick = atom({ plugin: 'cache-watch', key: 'tick' } as const, 0)
const isHidden = atom({ plugin: 'cache-watch', key: 'isHidden' } as const, false)
const keepWarmUntil = atom({ plugin: 'cache-watch', key: 'keepWarmUntil' } as const, null)
const fable = atom({ plugin: 'cache-watch', key: 'fable' } as const, null)

const MINUTE = 60_000
const TICK_MS = 30_000
const SOON_MINUTES = 5
const KEEP_WARM_LEAD_MINUTES = 4
const WARN_ABOVE_TOKENS = 50_000
const NEAR_ZERO_READ = 1_000
const ACCEPTED_KEY = 'cache-watch:accepted'

type Cache =
  | { kind: 'unknown' }
  | { kind: 'warm'; minutesLeft: number }
  | { kind: 'cold'; reason: string }

const tokens = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : `${n}`)

const ago = (ms: number) => {
  const minutes = Math.max(1, Math.round(ms / MINUTE))
  if (minutes < 60) return `${minutes} min`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours} h`
  return `${Math.round(hours / 24)} days`
}

const clockTime = (ms: number) => {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

const isSameDay = (a: number, b: number) => new Date(a).toDateString() === new Date(b).toDateString()

const cacheAt = (
  now: number,
  at: number | null,
  ttl: number,
  forced: string | null,
): Cache => {
  if (at === null) return { kind: 'unknown' }
  if (forced !== null) return { kind: 'cold', reason: forced }
  if (!isSameDay(at, now)) return { kind: 'cold', reason: 'new day' }
  const left = at + ttl * MINUTE - now
  if (left <= 0) return { kind: 'cold', reason: `last call ${ago(now - at)} ago` }
  return { kind: 'warm', minutesLeft: Math.ceil(left / MINUTE) }
}

let cfg = { ttlDefault: 60, maxKeepWarmHours: 2, usdPerMillion: 18.75 }
let isForking = false

const usd = (n: number) => `$${((n / 1_000_000) * cfg.usdPerMillion).toFixed(2)}`

const current = async ($: $, now: number) =>
  cacheAt(
    now,
    await read($, lastCallAt),
    await read($, ttlMinutes),
    await read($, forcedColdReason),
  )

const showStatus = async ($: $, now: number) => {
  const cache = await current($, now)
  if (cache.kind === 'unknown') $.ui.status(undefined)
  else if (cache.kind === 'warm') $.ui.status(`cache warm ${cache.minutesLeft}m`)
  else $.ui.status('cache cold')
}

// A switch of the main model since the last call forfeits the cache.
const checkModel = async ($: $) => {
  const before = await read($, lastModel)
  if (before === null) return
  const model = await $.session.model()
  if (model !== before) await update($, forcedColdReason, () => 'model switched')
}

const stopKeepWarm = async ($: $, message: string) => {
  await update($, keepWarmUntil, () => null)
  $.ui.toast(message)
}

const keepWarmStep = async ($: $, now: number) => {
  const until = await read($, keepWarmUntil)
  if (until === null || isForking) return
  if (now >= until) return stopKeepWarm($, 'cache-watch: keep-warm ended')
  const cache = await current($, now)
  if (cache.kind !== 'warm') return stopKeepWarm($, 'cache-watch: keep-warm stopped; the cache is already cold')
  if (cache.minutesLeft > KEEP_WARM_LEAD_MINUTES) return
  isForking = true
  try {
    const reply = await $.model.fork({ prompt: 'Reply with the single word ok.' })
    const served = 'usage' in reply ? reply.usage.cache_read_input_tokens : 0
    if (served < NEAR_ZERO_READ) {
      return stopKeepWarm($, 'cache-watch: keep-warm stopped; the cache had already expired')
    }
    const at = await $.clock.now()
    await update($, lastCallAt, () => at)
  } finally {
    isForking = false
  }
}

const startKeepWarm = async ($: $, hours: number) => {
  const now = await $.clock.now()
  const cache = await current($, now)
  if (cache.kind !== 'warm') {
    return 'cache-watch: the cache is not warm, so there is nothing to keep warm.'
  }
  const capped = Math.min(Math.max(hours, 0.1), cfg.maxKeepWarmHours)
  const until = now + capped * 60 * MINUTE
  await update($, keepWarmUntil, () => until)
  return `cache-watch: keeping the cache warm until ${clockTime(until)}.`
}

// The weekly Fable limit, from the endpoint /usage reads: the entry of `limits`
// with kind "weekly_scoped" and scope.model.display_name "Fable".
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
const FABLE_GAP_MS = 60_000
const FABLE_LOW_LEFT = 20

type RawLimit = {
  kind?: string
  percent?: number
  resets_at?: string | null
  scope?: { model?: { display_name?: string } | null } | null
}

let lastFableFetch = 0

const refreshFable = async ($: $, force = false) => {
  const now = await $.clock.now()
  if (!force && now - lastFableFetch < FABLE_GAP_MS) return
  lastFableFetch = now
  const failed = (error: string): FableReading => ({ percentUsed: null, resetsAt: null, error })

  const auth = await $.session.authorize()
  if (!auth) return update($, fable, () => failed('no Claude sign-in'))
  const res = await $.http.fetch(USAGE_URL, {
    auth: auth.handle,
    headers: { 'anthropic-beta': 'oauth-2025-04-20', 'content-type': 'application/json' },
  })
  if (!res.ok) return update($, fable, () => failed(`server answered ${res.status}`))

  const body = JSON.parse(res.text) as { limits?: RawLimit[] | null }
  const row = (body.limits ?? []).find(
    l => l.kind === 'weekly_scoped' && l.scope?.model?.display_name?.toLowerCase() === 'fable',
  )
  const reading: FableReading =
    row && typeof row.percent === 'number'
      ? { percentUsed: Math.round(row.percent * 10) / 10, resetsAt: row.resets_at ?? null, error: null }
      : failed('no Fable limit in the answer')
  await update($, fable, () => reading)
}

const fableLeft = (r: FableReading) =>
  r.percentUsed === null ? null : Math.max(0, Math.round((100 - r.percentUsed) * 10) / 10)

const fableText = (r: FableReading) => {
  const left = fableLeft(r)
  if (left === null) return `Fable: ${r.error ?? 'no reading'}`
  const d = r.resetsAt === null ? null : new Date(r.resetsAt)
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const reset = d === null ? '' : ` (resets ${days[d.getDay()]} ${d.getDate()}. ${d.getMonth() + 1}. ${clockTime(d.getTime())})`
  return `Fable ${left} % left${reset}`
}

export const register: Register = (on, options) => {
  cfg = {
    ttlDefault: Number(options.cacheTtlMinutes ?? 60) || 60,
    maxKeepWarmHours: Number(options.maxKeepWarmHours ?? 2) || 2,
    usdPerMillion: Number(options.cacheWriteUsdPerMillion ?? 18.75) || 18.75,
  }

  on('session.start', async ($, e, next) => {
    await update($, ttlMinutes, () => cfg.ttlDefault)
    await $.command.register({
      name: 'keep-warm',
      description: 'Keep the prompt cache warm for a capped time: /keep-warm [hours], or /keep-warm off',
      argumentHint: '[hours|off]',
      immediate: true,
    })
    await $.command.register({ name: 'fable', description: 'Refresh and show how much of the weekly Fable limit is left' })
    void refreshFable($, true)
    $.clock.every(TICK_MS, () => {
      void (async () => {
        const now = await $.clock.now()
        await checkModel($)
        await update($, tick, () => now)
        await showStatus($, now)
        await keepWarmStep($, now)
      })()
    })

    return next(e)
  })

  on('command.run', { command: 'fable' }, async $ => {
    await refreshFable($, true)
    const r = await read($, fable)
    return { text: r === null ? 'Fable: no reading yet.' : fableText(r) }
  })

  on('command.run', { command: 'keep-warm' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'off') {
      const was = await read($, keepWarmUntil)
      await update($, keepWarmUntil, () => null)
      return { text: was === null ? 'cache-watch: keep-warm was not running.' : 'cache-watch: keep-warm stopped.' }
    }
    const hours = arg === '' ? cfg.maxKeepWarmHours : Number(arg)
    if (!Number.isFinite(hours) || hours <= 0) {
      return { text: 'cache-watch: give a number of hours, for example /keep-warm 1, or /keep-warm off.' }
    }
    return { text: await startKeepWarm($, hours) }
  })

  on('prompt.submit', async ($, e, next) => {
    // The person's own prompts: typed at the terminal (composer), from Remote Control (bridge), or
    // from the desktop app, which stamps them 'sdk' or leaves them unclassified. Everything
    // the engine itself queues (notifications, scheduled triggers, peers, plugins) is skipped.
    const NOT_USERS = new Set([
      'task-notification', 'scheduled-trigger', 'peer', 'peer-send-message', 'projects-relay',
      'channel', 'coordinator', 'observer', 'observer-activity', 'plugin', 'auto-continuation', 'slack-ping',
    ])
    const isUsers = !NOT_USERS.has(e.origin.kind)
    if (isUsers && !e.text.trimStart().startsWith('/')) {
      await checkModel($)
      const now = await $.clock.now()
      const cache = await current($, now)
      const size = await read($, contextTokens)
      if (cache.kind === 'cold' && size !== null && size > WARN_ABOVE_TOKENS) {
        let answer = 'Send'
        try {
          answer = await $.ui.ask(
            `The conversation cache has expired (${cache.reason}). Sending will re-write about ${tokens(size)} tokens (about ${usd(size)}). Send anyway?`,
            { options: ['Send', 'Do not send'], header: 'Cache' },
          )
        } catch {
          answer = 'Send'
        }
        if (answer === 'Do not send') {
          return {
            drop: 'cache-watch: not sent; the conversation cache is cold. Start a new session with a handoff note, or send again to accept the re-write.',
          }
        }
        const count = Number((await $.store.get(ACCEPTED_KEY)) ?? 0) + 1
        await $.store.set(ACCEPTED_KEY, count)
      }
    }

    const entered = await next(e)
    if (entered.drop === undefined) {
      // The prompt entered: the turn's first API call reads (or re-writes) the prefix from now.
      const at = await $.clock.now()
      await update($, lastCallAt, () => at)
      await update($, forcedColdReason, () => null)
    }

    return entered
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined && e.usage !== undefined) {
      const usage = e.usage
      const now = await $.clock.now()
      const turn: CacheWatchTurn = {
        read: usage.cache_read_input_tokens,
        written: usage.cache_creation_input_tokens,
        isHit: usage.cache_read_input_tokens >= usage.cache_creation_input_tokens,
      }
      const measured = (await $.session.usage()).context.tokens
      const size =
        measured ??
        usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens + usage.output_tokens
      const model = await $.session.model()
      await update($, lastCallAt, () => now)
      await update($, lastModel, () => model)
      await update($, forcedColdReason, () => null)
      await update($, lastTurn, () => turn)
      await update($, contextTokens, () => size)
      await update($, tick, () => now)
      await showStatus($, now)
      void refreshFable($)
    }

    return next(e)
  })

  // The types and `claude plugin validate` accept these settings-hook events; whether
  // this build raises them for function hooks is not verified. The model check on
  // each tick covers a switch either way.
  on('classic.PreModelSwitch', async ($, e, next) => {
    await update($, ttlMinutes, () => (e.cache_ttl === '1h' ? 60 : 5))
    return next(e)
  })

  on('classic.PostModelSwitch', async ($, e, next) => {
    await update($, ttlMinutes, () => (e.cache_ttl === '1h' ? 60 : 5))
    if (e.context_tokens > 0) await update($, contextTokens, () => e.context_tokens)
    await update($, forcedColdReason, () => 'model switched')
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    const measured = e.context.tokens
    if (measured !== undefined) await update($, contextTokens, () => measured)

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const now = (await read($, tick)) || (await $.clock.now())
    const at = await read($, lastCallAt)
    if (e.props.hasSurvey || (await read($, isHidden))) return next(e)

    const cache = cacheAt(now, at, await read($, ttlMinutes), await read($, forcedColdReason))
    const size = await read($, contextTokens)
    const turn = await read($, lastTurn)
    const until = await read($, keepWarmUntil)
    const fableReading = await read($, fable)
    const { Box, Button, Text } = $.ui.resolve(e)

    const fableLeftNow = fableReading === null ? null : fableLeft(fableReading)
    const isFableLow = fableLeftNow !== null && fableLeftNow <= FABLE_LOW_LEFT
    const fablePart = fableReading === null ? null : (
      <Text dimColor={!isFableLow} color={isFableLow ? 'yellow' : undefined}>
        {'· '}{fableText(fableReading)}{' '}
      </Text>
    )

    const hide = <Button key="hide" label="Hide" dimColor onPress={() => update($, isHidden, () => true)} />

    if (cache.kind === 'unknown') {
      return (
        <Box>
          <Text dimColor>cache: no call yet </Text>
          {fablePart}
          {hide}
        </Box>
      )
    }

    if (cache.kind === 'cold') {
      const cost = size === null ? '' : ` · sending re-writes about ${tokens(size)} tokens, about ${usd(size)}`
      return (
        <Box>
          <Text color="yellow">cache cold ({cache.reason}){cost} </Text>
          {fablePart}
          {hide}
        </Box>
      )
    }

    const parts = [`cache warm · expires in ${cache.minutesLeft} min`]
    if (size !== null) parts.push(`${tokens(size)} tokens in context`)
    if (turn !== null) parts.push(`last turn: ${tokens(turn.read)} read, ${tokens(turn.written)} written`)
    if (until !== null) parts.push(`keeping warm until ${clockTime(until)}`)
    const isSoon = cache.minutesLeft < SOON_MINUTES

    return (
      <Box>
        <Text dimColor={!isSoon} color={isSoon ? 'yellow' : undefined}>
          {parts.join(' · ')}{' '}
        </Text>
        {fablePart}
        {isSoon && until === null && (
          <Button
            key="keep-warm"
            label="Keep warm"
            onPress={async () => {
              const text = await startKeepWarm($, cfg.maxKeepWarmHours)
              $.ui.toast(text)
            }}
          />
        )}
        {hide}
      </Box>
    )
  })
}
