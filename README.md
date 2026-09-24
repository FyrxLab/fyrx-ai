# FyrxAI

Drop-in AI support agent for [discord.js](https://discord.js.org) bots. Answers support questions in
your channels automatically, grounded in documentation you point it at, and stays quiet during normal
conversation, deciding locally so casual chat never costs an AI call. Configured entirely from Discord:
no code edits, no environment variables.

## What it does

- **Answers support questions without a mention** in the channels you configure, citing the wiki page it used
- **Decides locally what deserves an answer.** A k-NN intent classifier over a local multilingual
  embedding model (`Xenova/paraphrase-multilingual-MiniLM-L12-v2`, ONNX, CPU, ~15 ms per message)
  separates support questions from chat and off-topic requests, and a local semantic index of your wikis
  checks the message is actually about them. No API key needed for this part.
- **Only doubtful messages cost a little.** When local signals are unsure, a ~260-token YES/NO check
  runs before any full answer. Clear chat is ignored for free.
- **Cheap answers.** Only the passages relevant to the question are sent (~4k tokens instead of the
  whole wiki), found by meaning, so a Spanish question finds an English page.
- **Support only.** Regular members get wiki-grounded support; requests to write or debug code, or
  unrelated questions, get a canned refusal with no AI call. Server administrators can @mention it for anything.
- **Trainable from Discord.** Right-click a message → Apps → *FyrxAI: soporte / charla / fuera de tema*.
  A server's own labels outweigh the built-in examples, so it learns how your community talks.
- **Wikis without AI.** `/fyrxai wiki add` crawls a doc site (`llms.txt`, `sitemap.xml`, or links one hop
  out) or reads a **local folder** of `.md`/`.txt` files. `/fyrxai wiki refresh` re-downloads only the pages
  it already knows. Only the page content is kept, not site navigation.
- **Slow providers handled.** The typing indicator stays on; past 8 s the bot replies "investigating in
  depth…" and edits that message with the answer when it arrives (90 s timeout).
- **Cost controls:** per-user rate limit, per-server hourly cap on AI answers, and a `debug.txt` that
  explains every decision.
- Providers: **WaveSpeed**, **OpenRouter**, **Google AI Studio**, **Claude Platform**

## Install

```bash
npm install @fyrx/fyrxai
```

```js
// CommonJS
const setupFyrxAI = require('@fyrx/fyrxai');
setupFyrxAI(client);
```

```js
// ES modules
import setupFyrxAI from '@fyrx/fyrxai';
setupFyrxAI(client);
```

On the Discord side:

1. Enable the **Message Content** privileged intent (Developer Portal → Bot), and create the `Client`
   with `GatewayIntentBits.Guilds`, `GuildMessages` and `MessageContent`.
2. Invite the bot with the `applications.commands` scope (alongside `bot`) so it can register
   `/fyrxai` and the training context-menu commands.

Using it together with [`@fyrx/fyrx-assisted`](https://github.com/FyrxLab/Fyrx-Assisted) (canned replies)?
Set that one up **first**, so a message it already answered is never sent to the AI:

```js
setupFyrxAssisted(client);
setupFyrxAI(client);
```

### Requirements

- Node.js 20+ and discord.js 14.27+
- On first start the local model (~120 MB) is downloaded and cached; budget ~200 MB of extra RAM.
  Wiki indexes are built at startup and on every `wiki add`/`refresh`.
- Run **one** bot process. Two instances of the same bot will both answer every message.

### Updating

npm keeps the version you installed. On startup FyrxAI checks for a newer release and logs a line if
there is one; it never updates itself. Update explicitly:

```bash
npm update @fyrx/fyrxai
```

## Configure (in Discord)

Everything is under `/fyrxai`, visible by default only to members with **Manage Server**.

```
/fyrxai channel add|remove|list            channels where FyrxAI answers without a mention
/fyrxai wiki add name url [description]    crawl a doc site, or a folder path on the bot host, and index it
/fyrxai wiki refresh name [rediscover]     re-download the known pages and re-index (no AI);
                                           rediscover:true also looks for new pages
/fyrxai wiki remove|list
/fyrxai provider set provider model apikey model that writes the answers (reply visible only to you)
/fyrxai provider remove
/fyrxai persona set|remove                 extra instructions for the assistant
/fyrxai exempt adduser|removeuser|addrole|removerole|list   skip the per-user rate limit
/fyrxai limit calls_per_hour               hard cap on AI answers per hour (default 30, 0 = never)
/fyrxai logs console:true|false            print logs to the console, or only to debug.txt
/fyrxai debug                              sends you debug.txt (visible only to you)
/fyrxai status | help
```

Message context menu (right-click → Apps), Manage Server only:

```
FyrxAI: soporte        this is a support question
FyrxAI: charla         this is conversation, don't answer things like it
FyrxAI: fuera de tema  this is an off-topic request (code, general knowledge...)
```

API keys are stored AES-256-GCM encrypted in `fyrxai-data/` in your bot's working directory (outside
`node_modules`, so it survives redeploys). Add `fyrxai-data/` to `.gitignore` and back it up when moving
hosts, or you'll need to `provider set` again.

**Tip:** use a dedicated support channel. In a general chat channel, most messages are conversation.

## How a message is handled

| Situation | What happens | AI cost |
|---|---|---|
| Support channel, chat or not about the wikis | ignored | none |
| Support channel, clear question about the wikis | answer from the relevant passages | ~4k tokens |
| Support channel, doubtful | YES/NO check, then answer only on YES | ~260 tokens (+ answer) |
| @mention, asks for code or an unrelated task | canned "support only" reply | none |
| @mention, greeting or nothing related in the wikis | canned reply | none |
| @mention, support question | answer (doubtful ones pre-checked) | ~4k tokens |
| @mention by a server administrator | answer anything, docs included when relevant | varies |

Every decision is logged in `debug.txt` with `intent`, `conf` (classifier confidence) and `rel`
(relevance to the wikis). If it misjudges your server, label a few messages with the context menu.

## Supported providers

| Provider | `provider set` name | Example model |
|---|---|---|
| WaveSpeed | `wavespeed` | `anthropic/claude-haiku-4.5` |
| OpenRouter | `openrouter` | any OpenRouter model slug |
| Google AI Studio | `googleai` | `gemini-2.0-flash` |
| Claude Platform | `claude` | `claude-haiku-4-5-20251001` |

## Debugging

Everything FyrxAI does is appended to `fyrxai-data/debug.txt` (rotated at 2 MB): each decision with its
reason, each AI call with provider, model, latency and size (plus token usage on WaveSpeed), config commands and errors. API keys
are never logged. `/fyrxai debug` sends you the file to share when asking for help. It contains short
fragments of messages, so share it only with whoever is helping you.

## Development

```bash
node test.js
```

Runs the self-check: intent classification, cross-language wiki retrieval and per-server training.

## License

MIT — see [LICENSE](LICENSE).
