# FyrxAI

Drop-in AI-powered support agent for [discord.js](https://discord.js.org) bots. Answers
questions in your support channels automatically, grounded in documentation you point it
at — all configured from Discord chat, no code edits and no environment variables required.

## What it does

- Watches your configured support channels and answers support questions automatically (no mention needed)
- **Decides locally, for free, what deserves an answer** - a k-NN intent classifier over a local multilingual
  embedding model (`Xenova/paraphrase-multilingual-MiniLM-L12-v2`, ONNX, CPU, ~15 ms per message) tells
  support questions from casual chat and off-topic tasks, and a local semantic index of your wikis checks the
  message is actually about them. Chat never reaches the paid AI.
- **Trainable from Discord**: right-click any message → Apps → *FyrxAI: soporte / charla / fuera de tema*.
  Each server's labels outweigh the built-in examples, so it learns how your community talks.
- **Support only**: regular members get wiki-grounded support; requests to write/debug code or unrelated
  questions get a free canned refusal. Server administrators can @mention it for anything.
- Sends the AI only the passages relevant to the question (~3-4k tokens instead of the whole wiki), found by
  meaning, so a Spanish question finds an English page
- `/fyrxai wiki add` crawls a whole doc site (`llms.txt`, `sitemap.xml`, or links one hop out) **or reads a local
  folder** of `.md`/`.txt` files; `/fyrxai wiki refresh` re-downloads only the pages it already knows - no AI,
  no rediscovery (pass `rediscover:true` to look for new pages)
- Supports **WaveSpeed**, **OpenRouter**, **Google AI Studio**, and **Claude Platform** as the answering model
- Per-user rate limiting, a per-server hourly cap on AI answers, and a `debug.txt` explaining every decision
- @mention the bot while replying to someone's message and it answers about *that* message

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
/fyrxai wiki add name url [description]   crawl a doc site (or a local folder path) and index it locally
/fyrxai wiki refresh name [rediscover]     re-download the known pages and re-index (no AI)
/fyrxai wiki remove|list
/fyrxai provider set provider model apikey pick the model that answers questions; reply is ephemeral
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

## How a message is handled

| Situation | What happens | Cost |
|---|---|---|
| Support channel, looks like chat / not about the wikis | ignored | free |
| Support channel, support question about the wikis | AI answer with the relevant passages (stays silent if the AI judges it off-topic) | ~4k tokens |
| @mention, asks for code / unrelated task | canned "support only" reply | free |
| @mention, greeting or nothing in the wikis | canned reply | free |
| @mention, support question | AI answer | ~4k tokens |
| @mention by a server admin (or the owner ID) | AI answer, unrestricted | varies |

Each decision is logged in `debug.txt` with `intent`, `conf` and `rel` (wiki relevance) so you can see why.
If it misjudges your server's messages, label a few with the context menu - that fixes it without code.

## License

MIT — see [LICENSE](LICENSE). Use it in any bot, commercial or not.

## Debugging

Everything the module does internally (every decision to answer/skip a message with its reason, each
AI call with provider/model/latency/sizes, config commands run, errors) is always appended to
`fyrxai-data/debug.txt` (rotated at 2 MB to `debug.old.txt`). API keys are never logged. Run `/fyrxai debug`
to get the file as an ephemeral attachment when asking for help; it contains short fragments of
messages from support channels, so share it only with whoever is helping you. `/fyrxai logs console:false`
stops the console output without stopping the file.
