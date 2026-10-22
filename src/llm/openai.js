/**
 * OpenAI-compatible chat completions (llama.cpp, Ollama, OpenAI, ...) via fetch.
 */
import { LlmError } from "./errors.js";

const BACKOFF_MS = [2000, 4000];
const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

const retryable = (status) => status === 429 || status >= 500;

/**
 * @param {object} config
 * @param {{fetchImpl?: typeof fetch, sleep?: (ms:number)=>Promise<void>}} [opts]
 * @returns {{complete(prompt: string, schema: object, opts?: {signal?: AbortSignal}): Promise<string>}}
 */
export function createOpenAi(config, { fetchImpl = fetch, sleep = defaultSleep } = {}) {
  const url = `${config.llmBaseUrl}/chat/completions`;
  const headers = { "Content-Type": "application/json" };
  if (config.llmApiKey) headers.Authorization = `Bearer ${config.llmApiKey}`;

  /**
   * One attempt. Returns {text} on success, {retry, error} on a retryable failure (network
   * error, 429, 5xx); throws LlmError otherwise. A timeout is not retried: a model that
   * didn't answer in LLM_TIMEOUT_SECONDS won't answer faster on the next try.
   */
  async function attempt(body, signal) {
    const timeout = AbortSignal.timeout(config.llmTimeoutMs);
    let res;
    try {
      res = await fetchImpl(url, {
        method: "POST",
        headers,
        body,
        signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
      });
    } catch (err) {
      if (signal?.aborted) throw new LlmError("model request cancelled");
      if (err?.name === "TimeoutError") {
        throw new LlmError(`model request failed: timed out after ${config.llmTimeoutMs / 1000} s`);
      }
      return { retry: true, error: "model request failed: network error" };
    }
    if (!res.ok) {
      // Free the connection: nobody reads this body. Not awaited (a teed body's cancel
      // only settles once every branch is cancelled).
      res.body?.cancel?.().catch(() => {});
      const error = `model request failed: HTTP ${res.status}`;
      if (retryable(res.status)) return { retry: true, error };
      throw new LlmError(error);
    }
    let data;
    try {
      data = await res.json();
    } catch {
      throw new LlmError("model reply was not valid JSON");
    }
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== "string") throw new LlmError("model reply had no message content");
    return { text: content };
  }

  return {
    /**
     * @param {string} prompt
     * @param {object} schema
     * @param {{signal?: AbortSignal}} [opts] aborting the signal cancels the request (not retried)
     */
    async complete(prompt, schema, { signal } = {}) {
      const payload = {
        model: config.llmModel,
        messages: [{ role: "user", content: prompt }],
        temperature: 0,
      };
      if (config.llmJsonSchema) {
        payload.response_format = {
          type: "json_schema",
          json_schema: { name: "categorization", strict: true, schema },
        };
      }
      const body = JSON.stringify(payload);
      let last;
      for (let i = 0; i <= BACKOFF_MS.length; i++) {
        if (i > 0) await sleep(BACKOFF_MS[i - 1]);
        if (signal?.aborted) throw new LlmError("model request cancelled");
        last = await attempt(body, signal);
        if (!last.retry) return last.text;
      }
      throw new LlmError(last.error);
    },
  };
}
