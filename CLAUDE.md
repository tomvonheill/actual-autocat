# actual-autocat

A Docker container that categorizes an Actual Budget budget once per merchant: for each
new payee it optionally searches SearXNG, asks a model (any OpenAI-compatible server, or
Claude) for a category, creates an Actual rule `payee is X -> category`, categorizes
that payee's uncategorized transactions, and sends a Telegram summary.

For first-time setup, run `/setup`.

## Layout

- `src/index.js` CLI and scheduler: no command = cron scheduler, `run` = one run, `check` = test connections
- `src/config.js` every environment variable and its default (documented in `.env.example`)
- `src/run.js` one run; `select.js` which payees need a rule; `seeds.js` rules.yaml
- `src/query.js` bank line -> search query; `search.js` SearXNG + 30-day cache
- `src/prompt.js` prompt and reply validation; `src/llm/` openai (fetch) and anthropic (SDK)
- `src/actual.js` the only module that talks to `@actual-app/api`
- `src/summary.js` + `src/notify/telegram.js` the run summary
- `examples/` per-provider `.env` blocks and sample `config/guidance.md`, `config/rules.yaml`
- `docs/design.md` the design; `test/` node:test unit tests with synthetic data

## Commands

- Tests: `node --test` (Node 22, no build step, ES modules, plain JavaScript)
- With Docker: `docker compose run --rm autocat check`, `docker compose run --rm autocat run`
- Compose file: copy `docker-compose.example.yml` to `docker-compose.yml`

## Safety rules

- Start in dry run (`DRY_RUN=true`, the default). Only switch to live when the user says so.
- Never print, log, echo or commit secrets: `ACTUAL_PASSWORD`, `ACTUAL_ENCRYPTION_PASSWORD`,
  `LLM_API_KEY`, `TELEGRAM_BOT_TOKEN`. Never Read, Edit or print `.env` once it holds
  secrets (the user pastes them in their own editor); change a non-secret key with a
  one-line `sed`/`echo` that prints nothing (see `.claude/skills/setup/SKILL.md`).
- `.env`, `config/` and `data/` are the user's private files and are git-ignored.
- The tool never changes rules it didn't create or transactions that already have a category.
- Tests, examples and docs use made-up merchants only, never data from a real budget.
