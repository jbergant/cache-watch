# cache-watch

A Claude Code mod that shows one line above the prompt:

- whether the conversation's prompt cache is still warm, and how many minutes it has left;
- how much of the weekly Fable limit is left, and when it resets.

It also warns before a send that would re-write a cold cache, and `/keep-warm [hours|off]` keeps the cache warm for a capped time. `/fable` refreshes the Fable reading and prints it.

The Fable reading comes from the same usage endpoint that `/usage` reads, through the session's own sign-in; the mod never sees the token. It works only on a Claude subscription.

## Install

At the prompt of a terminal session:

```
/plugin install cache-watch --marketplace jbergant/cache-watch
```

Answer `y` to add the marketplace, then choose a scope.

From a shell:

```bash
claude plugin install cache-watch --marketplace jbergant/cache-watch
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `jbergant/cache-watch`, then Add plugin.

## Settings

- Cache lifetime in minutes: 60 for the 1-hour cache window (default), 5 for the Claude Code default.
- Keep-warm limit in hours: the longest time keep-warm runs (default 2).
- Cache-write price, USD per million tokens: used only for the cost estimate (default 18.75).
