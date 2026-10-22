/**
 * Environment-variable configuration. loadConfig validates and normalizes;
 * redact makes a config safe to print.
 */

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "ConfigError";
  }
}

const SECRET_KEYS = ["actualPassword", "actualEncryptionPassword", "llmApiKey", "telegramBotToken"];

function str(env, name, def = "") {
  const v = env[name];
  return v === undefined || v === null ? def : String(v).trim();
}

function required(env, name) {
  const v = str(env, name);
  if (!v) throw new ConfigError(`${name} is required`);
  return v;
}

function bool(env, name, def) {
  const v = str(env, name);
  if (v === "") return def;
  const l = v.toLowerCase();
  if (l === "true" || l === "1") return true;
  if (l === "false" || l === "0") return false;
  throw new ConfigError(`${name} must be true, false, 1 or 0 (got "${v}")`);
}

function int(env, name, def) {
  const v = str(env, name);
  if (v === "") return def;
  if (!/^\d+$/.test(v)) throw new ConfigError(`${name} must be a non-negative integer (got "${v}")`);
  return Number(v);
}

function positiveInt(env, name, def) {
  const n = int(env, name, def);
  if (n < 1) throw new ConfigError(`${name} must be at least 1 (got "${str(env, name)}")`);
  return n;
}

const stripSlash = (u) => u.replace(/\/+$/, "");

/** @param {Record<string,string|undefined>} env */
export function loadConfig(env) {
  const llmProvider = str(env, "LLM_PROVIDER", "openai").toLowerCase();
  if (llmProvider !== "openai" && llmProvider !== "anthropic") {
    throw new ConfigError(`LLM_PROVIDER must be "openai" or "anthropic" (got "${llmProvider}")`);
  }

  const actualServerUrl = stripSlash(required(env, "ACTUAL_SERVER_URL"));
  const actualPassword = required(env, "ACTUAL_PASSWORD");
  const actualBudgetId = required(env, "ACTUAL_BUDGET_ID");

  let llmBaseUrl = stripSlash(str(env, "LLM_BASE_URL"));
  const llmApiKey = str(env, "LLM_API_KEY");
  if (llmProvider === "openai") {
    if (!llmBaseUrl) throw new ConfigError("LLM_BASE_URL is required when LLM_PROVIDER=openai");
  } else {
    if (!llmApiKey) throw new ConfigError("LLM_API_KEY is required when LLM_PROVIDER=anthropic");
    if (llmBaseUrl) throw new ConfigError("LLM_BASE_URL must not be set when LLM_PROVIDER=anthropic");
  }
  const llmModel = required(env, "LLM_MODEL");

  let skipPayees = null;
  const skip = str(env, "SKIP_PAYEES");
  if (skip) {
    try {
      skipPayees = new RegExp(skip, "i");
    } catch (e) {
      throw new ConfigError(`SKIP_PAYEES is not a valid regular expression: ${e.message}`);
    }
  }

  return {
    actualServerUrl,
    actualPassword,
    actualBudgetId,
    actualEncryptionPassword: str(env, "ACTUAL_ENCRYPTION_PASSWORD"),
    llmProvider,
    llmBaseUrl,
    llmApiKey,
    llmModel,
    llmJsonSchema: bool(env, "LLM_JSON_SCHEMA", true),
    llmTimeoutMs: positiveInt(env, "LLM_TIMEOUT_SECONDS", 300) * 1000,
    searxngUrl: stripSlash(str(env, "SEARXNG_URL")),
    searchResults: int(env, "SEARCH_RESULTS", 3),
    schedule: str(env, "SCHEDULE", "0 2 * * *"),
    tz: str(env, "TZ", "UTC"),
    runOnStart: bool(env, "RUN_ON_START", false),
    dryRun: bool(env, "DRY_RUN", true),
    syncBeforeRun: bool(env, "SYNC_BEFORE_RUN", true),
    skipPayees,
    maxPayeesPerRun: int(env, "MAX_PAYEES_PER_RUN", 0),
    mixedPayeeCategory: str(env, "MIXED_PAYEE_CATEGORY"),
    notesTag: str(env, "NOTES_TAG", "#autocat"),
    telegramBotToken: str(env, "TELEGRAM_BOT_TOKEN"),
    telegramChatId: str(env, "TELEGRAM_CHAT_ID"),
    logLevel: str(env, "LOG_LEVEL", "info"),
    configDir: str(env, "CONFIG_DIR", "/config"),
    dataDir: str(env, "DATA_DIR", "/data"),
  };
}

/** Copy of config with secrets replaced by "***" when set. */
export function redact(config) {
  const out = { ...config };
  for (const k of SECRET_KEYS) if (out[k]) out[k] = "***";
  return out;
}
