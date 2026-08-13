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
- Basic per-user rate limiting so one person can't drain your AI budget alone

## Install

1. Copy the `FyrxAI/` folder into your bot's project root.
2. Install its dependencies (either `cd FyrxAI && npm install`, or merge `FyrxAI/package.json`'s
   `dependencies` into your own bot's `package.json`).
3. Make sure your bot has the **Message Content** privileged intent enabled (Discord Developer
   Portal → Bot → Privileged Gateway Intents), and that `Client` is created with the
   `GatewayIntentBits.MessageContent` and `GatewayIntentBits.GuildMessages` intents.
4. Your bot's invite link needs the `applications.commands` OAuth2 scope (alongside `bot`), so
   Discord lets it register the `/fyrxai` slash command.
5. In your bot's entry file:

```js
const setupFyrxAI = require('./FyrxAI');
setupFyrxAI(client);
```

That's it — no other wiring needed.

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
/fyrxai status                             show current config
/fyrxai help                               full command list
```

`provider set`'s reply is ephemeral (Discord's own "only visible to you" flag) — the key is never
posted as plain text in the channel, and there's no message to delete. Keys are stored
AES-256-GCM-encrypted on disk with a key generated automatically on first run
(`FyrxAI/data/.encryption.key`) — back that file up if you move servers, or the stored keys become
unreadable and you'll need to `provider set` again.

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
