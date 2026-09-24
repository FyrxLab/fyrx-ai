# FyrxAI

Drop-in AI-powered support agent for [discord.js](https://discord.js.org) bots. Answers
questions in your support channels automatically, grounded in documentation you point it
at — all configured from Discord chat, no code edits and no environment variables required.

## What it does

- Watches your configured support channels and answers questions automatically (no mention needed)
- `/fyrxai wiki add` **crawls the whole doc site**, not just the page you pasted — tries
  `llms.txt`, then `sitemap.xml`, then follows same-origin links one hop out
- Automatically extracts up to 100 keywords from the crawled content by pattern (headers, inline
  code, `/commands`, `%placeholders%`) — no AI needed for this part, so topic detection has real
  coverage from the moment a wiki is added, even before any AI provider is configured. If a
  provider *is* configured, its own AI-generated keyword pass is merged in on top.
- Configured entirely through the `/fyrxai` slash command — hidden from non-managers by Discord's
  own permission system, and the provider API key confirmation is ephemeral (visible only to
  whoever ran the command, never posted as plain text in the channel)
- Replies as a branded embed, not a plain message
- Supports **WaveSpeed**, **OpenRouter**, **Google AI Studio**, and **Claude Platform** as the
  answering model — pick one per server
- A local, offline embedding model (no API key needed) guesses which documented topic a message
  is about even when it doesn't name it directly; a separate fuzzy (edit-distance) match catches
  spacing/pluralization mismatches and typos in a wiki's name without needing the model at all
- Basic per-user rate limiting (with `/fyrxai exempt` to exclude specific users/roles, e.g. mods)
  so one person can't drain your AI budget alone
- @mention the bot for a guaranteed answer, bypassing every heuristic gate below — works in any
  channel, not just configured support ones. @mention it while replying to someone else's message
  and it answers about *that* message instead of your mention text

## Install

```bash
npm install @fyrx/fyrxai
```

Then, in your bot's entry file:

```js
// CommonJS
const setupFyrxAI = require('@fyrx/fyrxai');
setupFyrxAI(client);
```

```js
// ES modules (.mjs, or "type": "module" in your package.json)
import setupFyrxAI from '@fyrx/fyrxai';
setupFyrxAI(client);
```

Both work out of the box — no separate build, no different import path.

Two things to check on the Discord side:

1. Your bot needs the **Message Content** privileged intent enabled (Discord Developer Portal →
   Bot → Privileged Gateway Intents), and `Client` created with the `GatewayIntentBits.MessageContent`
   and `GatewayIntentBits.GuildMessages` intents.
2. Your bot's invite link needs the `applications.commands` OAuth2 scope (alongside `bot`), so
   Discord lets it register the `/fyrxai` slash command.

That's it — no other wiring, no config files, no env vars.

### Staying up to date

`npm install` resolves the package to a specific commit and stays there — it will **not**
silently pull in future changes on its own (deliberately: an auto-updating dependency would mean
every bot using this runs whatever lands in a future push, with no review). On startup, FyrxAI
checks GitHub for a newer tagged release and logs a line if one exists — it only informs, it never
applies anything. When you see that log line, update explicitly:

```bash
npm update @fyrx/fyrxai
```

## Configure (in Discord)

Everything is one slash command: `/fyrxai`. Discord only shows it to members with **Manage
Server** by default (enforced by Discord itself, not app-side code) — a server owner can further
restrict it in Server Settings → Integrations if needed.

```
/fyrxai channel add|remove|list           channels where FyrxAI answers automatically
/fyrxai wiki add name url [description]   crawl a doc site and add it as a source; description is
                                            optional and feeds topic detection alongside the
                                            crawled content
/fyrxai wiki refresh name                  re-crawl an existing wiki (same URL) after upstream
                                            docs change
/fyrxai wiki remove|list
/fyrxai provider set provider model apikey pick the model that answers questions (also used to
                                            generate topic keywords when you add/refresh a wiki);
                                            reply is ephemeral — only you see the confirmation
/fyrxai provider remove
/fyrxai persona set|remove                 optional extra system-prompt instructions
/fyrxai exempt adduser|removeuser user     exempt a user from the per-user cooldown
/fyrxai exempt addrole|removerole role     exempt a role (e.g. moderators) from the cooldown
/fyrxai exempt list                        list exempt users/roles
/fyrxai limit calls_per_hour                hard cap of paid AI answers per hour for this server (default 30, 0 = never)
/fyrxai logs console:true|false            print log lines to the console, or keep them only in debug.txt
/fyrxai debug                              sends you debug.txt (ephemeral)
/fyrxai status                             show current config
/fyrxai help                               full command list
```

`provider set`'s reply is ephemeral (Discord's own "only visible to you" flag) — the key is never
posted as plain text in the channel, and there's no message to delete. Keys are stored
AES-256-GCM-encrypted on disk with a key generated automatically on first run, in a `fyrxai-data/`
folder created in your bot's own working directory (not inside `node_modules`, so it survives
redeploys/`npm ci`) — add `fyrxai-data/` to your `.gitignore`, and back it up if you move hosts, or
the stored keys become unreadable and you'll need to `provider set` again.

## Supported providers

| Provider     | `provider set` name | Notes |
|--------------|---------------------|-------|
| WaveSpeed    | `wavespeed`          | OpenAI-compatible endpoint, model routing (e.g. `anthropic/claude-3-haiku`) |
| OpenRouter   | `openrouter`         | OpenAI-compatible, any model slug OpenRouter supports |
| Google AI Studio | `googleai`       | via `@google/generative-ai`, e.g. `gemini-2.0-flash` |
| Claude Platform | `claude`          | Anthropic Messages API directly, e.g. `claude-3-5-haiku-20241022` |

## Topic detection

Three layers, cheapest first:

1. **Exact match** — the wiki's name appears literally in the message.
2. **Fuzzy match** — edit-distance (Levenshtein) tolerant of spacing/pluralization differences and
   typos in the wiki's *name itself* (e.g. "conditional event" still matches a wiki named
   `conditionalevents`). This is plain string matching, not AI — semantic embedding models aren't
   built to be typo-tolerant, so this layer exists specifically because the local model isn't the
   right tool for that job.
3. **Local semantic model** (`Xenova/paraphrase-MiniLM-L3-v2`, ONNX, offline, no API key) — for
   messages that describe a problem without naming the wiki at all. Reference vectors come from
   the wiki's name + description run through several paraphrase templates, *plus* every keyword
   from the crawl embedded individually (regex-extracted automatically, and AI-generated on top
   if a provider is configured) — the keyword list is what gives this layer real coverage of the
   topic's actual vocabulary instead of just a one-line description. A match needs to both clear a
   similarity threshold and beat the runner-up topic by a margin, to cut down on
   confident-but-wrong guesses.

## License

MIT — see [LICENSE](LICENSE). Use it in any bot, commercial or not.

## Debugging

Everything the module does internally (every decision to answer/skip a message with its reason, each
AI call with provider/model/latency/sizes, config commands run, errors) is always appended to
`fyrxai-data/debug.txt` (rotated at 2 MB to `debug.old.txt`). API keys are never logged. Run `/fyrxai debug`
to get the file as an ephemeral attachment when asking for help; it contains short fragments of
messages from support channels, so share it only with whoever is helping you. `/fyrxai logs console:false`
stops the console output without stopping the file.
