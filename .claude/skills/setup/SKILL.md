---
name: setup
description: "Guided first-time setup for actual-autocat: asks about your Actual server, model and optional SearXNG/Telegram, writes .env, tests every connection and does a dry run"
disable-model-invocation: true
---

# Set up actual-autocat

Walk the user through a first setup, from nothing to a successful dry run. Go one step
at a time, keep explanations short and plain, and wait for the user where a step says so.

## Rules (always)

- **Never ask for, read back, or echo a secret.** Secrets are `ACTUAL_PASSWORD`,
  `ACTUAL_ENCRYPTION_PASSWORD`, `LLM_API_KEY` and `TELEGRAM_BOT_TOKEN`. You write their
  lines into `.env` with placeholder values; the user pastes the real values in their own
  editor. If the user pastes a secret into the chat anyway, don't repeat it, don't write it
  anywhere, and suggest they rotate it.
- Never `cat`, `grep` with output, or otherwise print `.env` after the user has filled in
  secrets. To check that a placeholder was replaced, use a command that prints only a count,
  e.g. `grep -c '^ACTUAL_PASSWORD=your-password$' .env` (0 means it was replaced).
- **Never use the Read or Edit tools on `.env` once the user has started pasting secrets
  into it** (both pull the whole file, secrets included, into the chat). Create `.env` with
  Write only in step 3, before any secret is in it. For any later change to a non-secret
  setting, use one shell command that prints nothing and touches only that key, replacing
  the line if it is set and appending it otherwise:

  ```sh
  grep -q '^KEY=' .env && sed -i.bak 's|^KEY=.*|KEY=value|' .env && rm .env.bak || echo 'KEY=value' >> .env
  ```

  (`sed -i.bak` works with both GNU and macOS sed.) Lines commented out with `#` count as
  absent, so the value is appended. Or ask the user to make the change in their editor.
  Secret values are always changed by the user, never by you.
- **Never set `DRY_RUN=false` unless the user explicitly says to go live.**
- Verify with `docker compose run --rm autocat check`, never by guessing.
- When something fails, explain what it means in plain words and the fix, then re-run.
- Don't commit anything; `.env`, `config/` and `data/` are git-ignored on purpose.

## 1. Prerequisites

- Run `docker compose version`. If Docker or the Compose plugin is missing, point the user
  to https://docs.docker.com/get-docker/ and stop until it works.
- If `.env` already exists, don't open it (it may hold secrets). Ask whether to keep it and
  skip to step 4, or to move it aside (`mv .env .env.old`) and start fresh.
- If `docker-compose.yml` doesn't exist, copy `docker-compose.example.yml` to it.
- Create the folders the container uses: `mkdir -p config data`.

## 2. Ask about their setup

Ask **one question at a time**, waiting for each answer:

1. **Where does Actual run?** Work out `ACTUAL_SERVER_URL` *as seen from inside the
   container*: `localhost` there is the container itself. Same machine →
   `http://host.docker.internal:5006` (the compose file maps it); another machine → its
   LAN address; Actual in the same Docker network → its service name. Also ask for the
   budget's **Sync ID** (Actual → Settings → Show advanced settings; not a secret) and
   whether the budget uses **end-to-end encryption**.
2. **Which model?** A local OpenAI-compatible server (llama.cpp, Ollama, LM Studio, vLLM)
   or a hosted one (OpenAI, OpenRouter, Claude). Offer the matching file as the starting
   point: `examples/llamacpp.env`, `examples/ollama.env`, `examples/lmstudio.env`,
   `examples/openai.env`, `examples/openrouter.env` or `examples/claude.env`. Ask for the
   server address and model name if local. For a hosted model, mention in one sentence
   what gets sent to the provider (README → Privacy).
3. **Do they run SearXNG?** If yes, use `examples/searxng.env`, ask for its URL, and remind
   them JSON output must be enabled in SearXNG's `settings.yml`. If no, skip it: search is
   optional.
4. **Do they want Telegram summaries?** If yes, they need a bot token from @BotFather
   (secret, they paste it) and their chat ID (not secret; you may ask for it).

## 3. Write `.env`

Create `.env` with the Write tool (this is the only time you write the whole file, and the
only time before secrets are in it). Start from `.env.example` and replace the model block with the chosen `examples/*.env`
(plus `examples/searxng.env` if used). Fill in every non-secret value from the answers.
Leave `DRY_RUN=true`. Leave each needed secret line with its placeholder
(`ACTUAL_PASSWORD=your-password`, `LLM_API_KEY=...`, `TELEGRAM_BOT_TOKEN=...`,
`ACTUAL_ENCRYPTION_PASSWORD=...` uncommented only if the budget is encrypted).

Then tell the user exactly which lines to fill in, ask them to open `.env` in their own
editor and paste the values, and **wait until they confirm**. Check the placeholders are
gone with the count-only `grep -c` from the rules.

## 4. Build and check

Run `docker compose build`, then `docker compose run --rm autocat check`. It tests the
Actual login and budget download, one tiny model request, one SearXNG query and one
Telegram message, then prints the budget's categories and how many transactions are
uncategorized. It changes nothing in Actual. Explain any `✗` line and fix it, then re-run
until everything passes. Common causes:

- **Actual unreachable / connection refused**: the URL is wrong from inside the container
  (`localhost`), or the server isn't listening on that address.
- **Actual login or download errors that mention versions, migrations or sync**: the
  `@actual-app/api` version doesn't match the server. Find the server version (Actual →
  Settings, or its Docker image tag) and rebuild:
  `docker compose build --build-arg ACTUAL_API_VERSION=<server version>`.
- **Encrypted budget**: the user adds `ACTUAL_ENCRYPTION_PASSWORD=<their password>` to `.env`
  in their own editor (it's a secret, so you don't touch that line).
- **Model HTTP 400**: the server rejects the JSON schema → set `LLM_JSON_SCHEMA=false` with
  the one-key command from the rules; or the
  model name is wrong; or a hosted reasoning model rejects `temperature` → pick another model.
- **Model HTTP 401/403**: API key missing or wrong (the user fixes it in `.env`).
- **Model timed out**: the server is slow or unreachable; check the URL, raise
  `LLM_TIMEOUT_SECONDS`.
- **SearXNG 403 or HTML**: JSON output is off; add `json` to `search.formats` in SearXNG's
  `settings.yml` and restart it.
- **Telegram failed**: wrong token or chat ID, or the user never sent the bot a message
  (a bot can only message people who started a chat with it).
- **`EACCES` on `/data`**: the `data` folder isn't writable by the container's user (UID
  1000): `sudo chown 1000:1000 data`.
- **`Configuration error: ...`**: the message names the variable; fix that line.

## 5. Guidance and seed rules (optional)

Using the categories `check` printed, offer to draft `config/guidance.md` together: one
line per category saying what belongs there in this budget (see
`examples/config/guidance.md` for the style). Use only the user's own category names and
what they tell you. Then offer to add `config/rules.yaml` entries (`payee name: category
name`) for merchants they already know. Re-run `check`; it confirms every category name
in `rules.yaml` exists.

## 6. Dry run

If the model is slow and many transactions are waiting, suggest `MAX_PAYEES_PER_RUN=20`
for this first try (set it with the one-key command from the rules, if the user agrees). Run `docker compose run --rm autocat run` (still `DRY_RUN=true`).
Show the user the result: the Telegram summary if configured, otherwise the log lines
(`<payee>: <category> (<seconds>s)`). Explain what would change: one rule per listed
merchant, and those merchants' uncategorized transactions categorized and tagged with
`#autocat` in their notes. Point out anything that looks wrong and how guidance or a
`rules.yaml` entry would fix it; offer to adjust and dry-run again.

## 7. Going live

Explain, then wait for the user to decide:

- Going live means setting `DRY_RUN=false` in `.env` and starting the scheduler with
  `docker compose up -d`. It runs on `SCHEDULE` (default `0 2 * * *`, every night at
  02:00 in `TZ`, default UTC); `RUN_ON_START=true` also runs once at start. Runs never
  overlap.
- Every rule created is listed in the summary with the model's reason and appended to
  `data/rules-created.jsonl`.
- To fix or undo a rule: edit or delete it in Actual → Rules. Transactions it categorized
  keep their category; change them in Actual (search notes for `#autocat` to find them).
  Once a rule is deleted (seed or model-made), the model decides that payee on the next
  run like any new one; a deleted seed is not recreated from `rules.yaml`. To have a payee
  left alone, add it to `SKIP_PAYEES`. Seeds are created first, even for payees matching
  `SKIP_PAYEES`.
- Logs: `docker compose logs -f autocat`.

Only if the user says to go live: set `DRY_RUN=false` with the one-key command from the
rules (never Read or Edit `.env`):

```sh
grep -q '^DRY_RUN=' .env && sed -i.bak 's|^DRY_RUN=.*|DRY_RUN=false|' .env && rm .env.bak || echo 'DRY_RUN=false' >> .env
```

then run `docker compose up -d`.
