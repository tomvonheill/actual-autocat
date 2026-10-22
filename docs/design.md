# actual-autocat: design

Status: draft for review, 2026-10-22.

## What it is and why

`actual-autocat` is a small Docker container that categorizes new merchants in an
[Actual Budget](https://actualbudget.org) budget and turns each decision into an Actual
rule, so the merchant is categorized automatically by Actual itself from then on.

It exists because the existing option (sakowicz/actual-ai) works one transaction at a
time and never learns: it asked a model about the same pharmacy 45 times in one run, and
categorizing a merchant through Actual's API does not trigger Actual's own "learn
categories" behavior (that only runs for edits made in Actual's UI). In real budgets a
few merchants make up most transactions (in the budget this was built for, 113 payees
cover 357 transactions and the top 10 cover half), so deciding **once per merchant** and
writing a rule is both cheaper and more consistent.

The owner does not want to review anything day to day. Rules are created automatically
and a chat message lists what was created, so mistakes are visible and easy to fix in
Actual.

It will be a **public GitHub repo** with a README that explains everything, usable by
anyone running Actual with any OpenAI-compatible model server or Claude, and optionally
their own SearXNG.

## Goals

- Categorize uncategorized transactions by deciding once per payee and creating an Actual
  rule `payee is <payee> → set category <category>`, then apply that category to the
  payee's existing uncategorized transactions.
- Everything configurable through environment variables, documented in a commented
  `.env.example` and the README. No code changes needed to point it at a different
  model, search instance, budget or chat.
- Model providers: any OpenAI-compatible chat completions server (llama.cpp, Ollama,
  LM Studio, vLLM, OpenAI, OpenRouter), and Anthropic's Claude via the official
  `@anthropic-ai/sdk`. Switching is a matter of changing `LLM_PROVIDER`, `LLM_API_KEY`
  and `LLM_MODEL` (and `LLM_BASE_URL` for OpenAI-compatible servers).
- Optional merchant lookup through a SearXNG instance given by `SEARXNG_URL`; the search
  results are added to the prompt. The model never calls tools: search runs first and
  the model only reads the results (small local models are unreliable at tool calling).
- Optional Telegram summary after each run that did something.
- Safe to adopt: a dry-run mode that changes nothing and reports what it would do.
- Works with small local models: one short prompt per merchant (about 1,800 tokens with
  search results), no tool calling, no long context.

## Non-goals

- Not a general Actual automation tool: no transfers, splits, budgeting, payee renaming,
  or credit-card payment handling.
- No web UI and no review queue. The chat message plus Actual's own Rules page are the
  interface.
- Does not re-categorize anything that already has a category, and never changes or
  deletes rules it did not create.
- No other notification channels in v1 (the notifier is one module, so others can be
  added later).
- No published container image in v1; users build it from the repo. A GitHub Actions
  workflow publishing to GHCR can come later.

## Anti-goals (failure even if it "works")

- Any of the owner's personal data in the public repo: real transactions, payee names
  from the real budget, category IDs, Tailscale hostnames or IPs, tokens. Examples and
  test fixtures are synthetic.
- Overwriting rules or categories the user set themselves.
- A wrong category locked in silently: every rule created must appear in the summary
  with the model's one-line reason.
- Requiring a cloud service. The default story is fully local (local model, own
  SearXNG); cloud providers are an option.

## How a run works

1. Connect to Actual with `@actual-app/api` (download the budget into a data directory
   inside the container). If `SYNC_BEFORE_RUN=true`, run bank sync first (skipped in dry
   run, since it imports transactions into the budget). When live, each payee's writes are
   preceded by a server sync and a fresh read of the rules (a payee you made a rule for
   meanwhile is left alone), and each transaction is re-read before it is categorized (one
   you categorized meanwhile is left alone).
2. Load categories (with their groups), payees, rules, and uncategorized transactions
   (not transfers, not starting balances, not split parents, accounts not closed,
   on-budget accounts only).
3. Drop transactions whose payee name matches `SKIP_PAYEES` (a regex; default empty, the
   README shows how to skip card payments and transfers).
4. Group by payee. Skip transactions with no payee. Skip payees that the user's rules
   already cover: any rule with a `set category` action whose conditions mention this
   payee in any way (`payee is`, `payee is one of`, with or without other conditions).
   The tool never creates a rule that could compete with one the user wrote, and never
   applies a user's rule itself. Their leftover uncategorized transactions (typically
   ones that arrived before the rule existed) are counted in the summary as "left for
   your rules", since Actual's Rules page can apply a rule to existing transactions.
5. Seed rules first: for every entry in the optional `/config/rules.yaml`
   (`payee name: category name`) whose payee exists and has no category rule, create the
   rule and categorize that payee's uncategorized transactions, exactly like a model
   decision (logged, listed in the summary with reason "from rules.yaml"). These never
   go to the model. Each seed is created **once**: seeds already created are recorded in
   `/data/state.json`, so if the user later deletes that rule in Actual, it is not
   recreated (the model then decides that payee like any other; `SKIP_PAYEES` leaves it
   alone). Seeds run before step 3, so they apply even to payees matching `SKIP_PAYEES`.
   Unknown payee or category names are reported in the summary and retried on
   later runs (the payee may not have appeared yet).
6. For each remaining payee, in order of most transactions first:
   1. Build a search query from the most recent raw bank line (Actual's `notes` for
      bank-synced transactions, which hold the bank's description): strip
      card-processor prefixes (`TST*`, `SQ *`, `PAYPAL *`…), store numbers, ACH
      boilerplate (`PPD ID:`, `WEB ID:`…), trailing state codes. Fall back to the payee
      name if nothing remains. The rules for this are in one module with unit tests
      (ported from the author's private benchmark prototype, which stays outside the
      repo; the repo's tests use synthetic bank lines written for the purpose, never
      lines from a real budget).
   2. If `SEARXNG_URL` is set, query `GET {SEARXNG_URL}/search?q=…&format=json` and keep
      the first `SEARCH_RESULTS` results that have a snippet, as
      `- <title>: <snippet, up to 200 chars>`. Cache results in the data directory for
      30 days so reruns don't search again.
   3. Ask the model (one request). The prompt contains: the task, the category list
      grouped (names only, with an opaque index or ID), the optional user guidance from
      `/config/guidance.md`, the search results block when there is one (with the
      caveat that results may be about a different business), and the transaction:
      payee name, up to 3 distinct raw bank lines, typical amount, income or expense.
   4. The answer is JSON `{"category": "<category id or \"varies\">", "reason": "<one short line>"}`.
      `"varies"` means the merchant has no single category (marketplaces, big-box
      stores, payment apps, ATMs). The prompt explains when to use it.
      - A category ID: validate that it exists and is not an income category for an
        expense (and vice versa).
      - `"varies"`: use the category named in `MIXED_PAYEE_CATEGORY` (the owner sets
        Miscellaneous). If that setting is empty, the payee is left uncategorized and
        listed as "varies, left alone"; it is remembered in `/data/state.json` and not
        asked about again.
      - Invalid answer or failed request: skip the payee for this run and list it as
        "not decided" in the summary. It is asked again next run.
   5. Unless dry run: create the rule, then set the category on that payee's
      uncategorized transactions found in step 2. Append an entry to
      `/data/rules-created.jsonl` (timestamp, payee, category, reason, rule ID, number
      of transactions) so a user can audit or undo.
7. Disconnect cleanly (`api.shutdown()`), which syncs changes to the server.
8. If anything was created, decided, or failed, send the summary.

Runs never overlap: if a scheduled run is still going when the next one is due, the next
is skipped with a log line.

## Model providers

| `LLM_PROVIDER` | Talks to | How |
|---|---|---|
| `openai` | any server with an OpenAI-compatible `/chat/completions` | plain `fetch` to `{LLM_BASE_URL}/chat/completions`, `Authorization: Bearer` only when `LLM_API_KEY` is set |
| `anthropic` | Anthropic API | official `@anthropic-ai/sdk`, `messages.create` with structured output so the reply is always valid JSON |

- For `openai`, send `response_format` with a JSON schema whose `category` is an enum of
  the valid IDs (llama.cpp, OpenAI, vLLM and recent Ollama honor it). Some servers
  reject it, so `LLM_JSON_SCHEMA=false` turns it off and the reply is parsed leniently
  (first JSON object in the text). Temperature 0.
- For `anthropic`, use effort `low` (classification does not need deep thinking) and a
  small `max_tokens`. Default model in `.env.example`: `claude-opus-5-5`; the README
  notes cheaper Claude models work by changing `LLM_MODEL`.
- `LLM_TIMEOUT_SECONDS` applies to both. Default 300 (small local machines are slow).
- Thinking/reasoning output from local models (e.g. Qwen thinking mode) is ignored; only
  the final message content is parsed.

## Configuration

All environment variables, documented in `.env.example` with a comment on each. Required
ones fail fast at startup with a clear message.

| Variable | Default | Meaning |
|---|---|---|
| `ACTUAL_SERVER_URL` | required | Actual server URL as reachable from the container |
| `ACTUAL_PASSWORD` | required | Actual server password |
| `ACTUAL_BUDGET_ID` | required | Budget's Sync ID (Settings → Advanced) |
| `ACTUAL_ENCRYPTION_PASSWORD` | empty | Only for end-to-end encrypted budgets |
| `LLM_PROVIDER` | `openai` | `openai` or `anthropic` |
| `LLM_BASE_URL` | required for `openai` | e.g. `http://localhost:8080/v1`, `http://ollama:11434/v1`, `https://api.openai.com/v1` |
| `LLM_API_KEY` | empty | Required for hosted providers |
| `LLM_MODEL` | required | Model name the server expects |
| `LLM_JSON_SCHEMA` | `true` | Send a JSON schema with OpenAI-compatible requests |
| `LLM_TIMEOUT_SECONDS` | `300` | Per request |
| `SEARXNG_URL` | empty | SearXNG base URL; empty disables search. JSON output must be enabled in SearXNG's `settings.yml` (`search.formats: [html, json]`) |
| `SEARCH_RESULTS` | `3` | Results per merchant |
| `SCHEDULE` | `0 2 * * *` | Cron expression; empty = run once and exit (for `docker compose run` or host cron, not `up -d`) |
| `TZ` | `UTC` | Time zone for the schedule |
| `RUN_ON_START` | `false` | Also run once when the container starts |
| `DRY_RUN` | `true` | Report only; nothing in Actual changes |
| `SYNC_BEFORE_RUN` | `true` | Run bank sync before categorizing |
| `SKIP_PAYEES` | empty | Regex of payee names to leave alone |
| `MAX_PAYEES_PER_RUN` | `0` (no limit) | Cap for a first run on a slow model |
| `MIXED_PAYEE_CATEGORY` | empty | Category name for merchants the model says have no single category (e.g. `Miscellaneous`); a rule is made to it. Empty = leave them uncategorized |
| `NOTES_TAG` | `#autocat` | Appended to the notes of transactions it categorizes; empty disables |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | empty | Both set = send summaries |
| `LOG_LEVEL` | `info` | `debug` logs prompts and model replies |

Mounted files (optional), under `/config`:
- `guidance.md`: free text added to the prompt, e.g. how this budget uses its categories.
- `rules.yaml`: `payee name: category name` pairs created as rules before anything else.

Writable volume `/data`: the downloaded budget cache, the search cache, and
`rules-created.jsonl`.

The commands available: `node src/index.js` (scheduler, the default), `… run` (one run
now, honoring `DRY_RUN`), and `… check` (tests every configured connection: Actual
login and budget download, the model with one tiny request, SearXNG with one query,
Telegram with one test message; then prints the budget's category groups and categories
and how many transactions are uncategorized). `check` never prints secrets and changes
nothing in Actual. With compose: `docker compose run --rm autocat run` / `… check`.

## Example configuration

Three layers, so people can start from whatever matches their setup:

- `.env.example`: every variable, each with a comment saying what it does, its
  default, and an example value. Copy to `.env` and fill in.
- `examples/`: ready-to-copy, commented `.env` fragments for common setups, each a
  complete working combination of the model and search settings:
  `llamacpp.env`, `ollama.env`, `lmstudio.env`, `openai.env`, `openrouter.env`,
  `claude.env`, and `searxng.env` (with a note on enabling JSON output).
- `examples/config/`: a sample `guidance.md` (category guidance for a typical budget,
  written in the same style as the owner's benchmarked prompt but with generic
  categories and no real merchants) and a sample `rules.yaml`.

All example values are placeholders (`your-password`, `http://localhost:8080/v1`,
`https://searx.example.com`); nothing from the owner's setup.

## Setting it up with Claude Code

The repo ships Claude Code's standard project files so someone can clone it, run
`claude` in the folder, and type `/setup`:

- `CLAUDE.md`: short, always-loaded context: what the tool is, the repo layout, how to
  run tests, the safety rules (start in dry run; never print or commit secrets), and
  "for first-time setup, run `/setup`".
- `.claude/skills/setup/SKILL.md`: the guided setup, invoked as `/setup`.
  Frontmatter: `name: setup`, a `description`, and `disable-model-invocation: true` so
  it only runs when the user asks (it starts containers). The steps:
  1. Check prerequisites: Docker with Compose, and that `.env` doesn't exist yet (or
     ask before changing it).
  2. Ask, one question at a time, where Actual runs, which model provider they use (or
     want), whether they have SearXNG, and whether they want Telegram summaries. Offer
     the matching `examples/*.env` as the starting point.
  3. Write `.env` with the non-secret values filled in and the secret lines
     (`ACTUAL_PASSWORD`, `LLM_API_KEY`, `TELEGRAM_BOT_TOKEN`, encryption password)
     left for the user to paste in their own editor, so secrets never pass through the
     chat. Wait for them to confirm.
  4. Build the image and run `check`. Explain any failure in plain words with the fix
     (wrong URL as seen from inside a container, SearXNG JSON format disabled, API
     version mismatch, and so on), and re-run until it passes.
  5. Using the categories `check` printed, offer to draft `config/guidance.md` with the
     user, and to add `rules.yaml` entries for merchants they already know.
  6. Run once in dry run, show the summary, and explain what would change.
  7. Explain how to go live (`DRY_RUN=false`), how the schedule works, and how to fix or
     undo a rule. Never switch to live without the user saying so.
- No `.claude/settings.json`: a public repo shouldn't pre-approve commands on the
  user's machine, so Claude Code asks before each command as usual.
- `.gitignore` covers `.env`, `config/` (the user's own guidance and rules), `data/`
  and `.claude/settings.local.json`.

The README has a short "Set up with Claude Code" section pointing to `/setup`, next to
the manual instructions.

## Summary message

Plain text, one message per run (split if over Telegram's 4,096-character limit). Sent
only when the run did something or failed. Example:

```
Budget: 3 new rules, 7 transactions categorized
• Corner Roasters → Coffee & Snacks: coffee shop chain (2)
• Metro Transit Card → Rideshare & Transit: city transit fare card (4)
• Lakeside Music Hall → Entertainment: concert venue (1)
• Target → Miscellaneous: varies, general store (3)
Not decided: 1 (model reply invalid): Oak Street Property Mgmt
Fix a rule in Actual → Rules.
```

Dry run says "would create" and is labeled DRY RUN. A failed run (Actual unreachable,
model unreachable) sends one short line with the error, followed by the usual lines for
anything it did before failing.

## Repo layout

```
Dockerfile                 node:22-slim based, non-root user, no ports
docker-compose.example.yml one service, env_file, /config and /data volumes
.env.example               every variable with a comment
examples/                  per-provider .env fragments, sample config/ files
CLAUDE.md                  context for Claude Code
.claude/skills/setup/      the /setup guided setup
README.md                  everything a stranger needs (see below)
LICENSE                    MIT
package.json / lockfile    @actual-app/api, @anthropic-ai/sdk, a cron library, a YAML parser
src/                       index (scheduler/CLI), config, actual (API wrapper), search,
                           query (bank-line cleanup), prompt, llm/openai, llm/anthropic,
                           notify/telegram, run (the steps above)
test/                      node:test unit tests with synthetic fixtures
docs/design.md             this document
```

Plain JavaScript (ES modules) on Node 22, no build step. Tests with `node --test`.

`@actual-app/api` must be compatible with the user's Actual server version. Pin it to a
current release and document in the README how to build with a different version
(`--build-arg ACTUAL_API_VERSION=…`), since a mismatch is the most common way this kind
of tool breaks.

## README contents

What it does and why (the once-per-merchant idea), how it compares to actual-ai, quick
start with Docker Compose, every setting, provider recipes (llama.cpp, Ollama, LM Studio,
OpenAI, OpenRouter, Claude), SearXNG setup (enabling JSON output, keeping it private),
the guidance and seed-rules files, first run in dry run then live, how to fix or undo a
rule, privacy (what text leaves your machine, and to whom, per provider and for search),
troubleshooting (API version mismatch, encrypted budgets, model returns invalid JSON,
SearXNG returns 403/HTML), and limitations.

## README visuals

The README is the GitHub landing page, so it should explain the idea at a glance. All
visuals use made-up merchants and categories.

- **Hero image** at the top (`docs/images/hero-light.svg` and `hero-dark.svg`, shown
  with a `<picture>` element and `prefers-color-scheme` so it matches the visitor's
  GitHub theme). It shows the core idea left to right: a raw bank line
  (`SQ *BLUE BOTTLE OAKLAND CA`) → merchant lookup → model decision
  ("Coffee & Snacks: coffee roaster and café chain") → an Actual rule → "every future
  Blue Bottle transaction categorized by Actual itself". Hand-written SVG with real
  text (sharp at any size, readable by screen readers through `alt` text), under 50 KB.
- **"How a run works"**: a Mermaid flowchart (GitHub renders Mermaid natively and
  adapts it to light and dark): sync → uncategorized → skip known payees → seed rules →
  per merchant search, decide, rule, categorize → summary.
- **"Night one vs. every night after"**: a Mermaid sequence diagram showing a new
  merchant going through search and the model once, and its later transactions being
  categorized by the rule at import with no model call. This is the main selling point
  over per-transaction tools.
- **"Where it runs"**: a Mermaid diagram of the pieces and the choices for each: Actual
  server; the model (local OpenAI-compatible server or a hosted provider); SearXNG
  (optional); Telegram (optional). It doubles as the privacy picture: which arrows
  carry transaction text off the machine.
- **Example summary**: an SVG drawn to look like the Telegram message
  (`docs/images/summary.svg`, light and dark), so people see what they'll get.
- Small touches: badges (license, Node version, Docker), a one-line tagline, and a
  table of contents.

## Testing

- Unit tests (no network): query cleanup, prompt building, reply parsing and validation,
  rule and summary building, config validation.
- An integration check before the first live deployment: a throwaway Actual server in
  Docker (same version as the production server), loaded with a copy of a real budget,
  never the live one. Run the tool against it live (not dry run) and confirm the
  rules, categories, notes tags and summary in that copy.
- A benchmark of model + prompt + search on the owner's labelled transactions lives
  outside the repo (it contains personal data).

## Left to the builder

Module boundaries inside `src/`, the cron and YAML libraries, log format, exact prompt
wording (keep it short; it must fit small models), how the JSON reply is parsed
leniently, and the retry policy for transient HTTP errors (a couple of retries with
backoff is enough).
