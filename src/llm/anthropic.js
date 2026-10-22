/**
 * Claude via the official Anthropic SDK, using structured output
 * (output_config.format) at low effort. No thinking or temperature params.
 *
 * The SDK's own retries are off (it would also retry timeouts, so one slow request
 * could take three times LLM_TIMEOUT_SECONDS). Retried here instead, like the OpenAI
 * provider: connection errors, 429 and 5xx, twice, after 2 s and 4 s. Timeouts and
 * cancelled requests are not retried.
 */
import Anthropic, { APIConnectionError, APIConnectionTimeoutError, APIUserAbortError } from "@anthropic-ai/sdk";
import { LlmError } from "./errors.js";

const BACKOFF_MS = [2000, 4000];
const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** @returns {"retry"|"timeout"|"cancelled"|"fail"} */
function classify(err) {
  if (err instanceof APIUserAbortError) return "cancelled";
  if (err instanceof APIConnectionTimeoutError) return "timeout";
  if (err instanceof APIConnectionError) return "retry";
  if (err?.status === 429 || err?.status >= 500) return "retry";
  return "fail";
}

/**
 * @param {object} config
 * @param {{anthropicClient?: {messages: {create: Function}}, makeClient?: (opts: object) => object,
 *   sleep?: (ms: number) => Promise<void>}} [opts]
 * @returns {{complete(prompt: string, schema: object, opts?: {signal?: AbortSignal}): Promise<string>}}
 */
export function createAnthropic(
  config,
  { anthropicClient, makeClient = (o) => new Anthropic(o), sleep = defaultSleep } = {},
) {
  const client =
    anthropicClient ?? makeClient({ apiKey: config.llmApiKey, timeout: config.llmTimeoutMs, maxRetries: 0 });

  async function request(prompt, schema, signal) {
    for (let i = 0; ; i++) {
      if (i > 0) await sleep(BACKOFF_MS[i - 1]);
      if (signal?.aborted) throw new LlmError("model request cancelled");
      try {
        return await client.messages.create(
          {
            model: config.llmModel,
            max_tokens: 1024,
            messages: [{ role: "user", content: prompt }],
            output_config: { effort: "low", format: { type: "json_schema", schema } },
          },
          signal ? { signal } : undefined,
        );
      } catch (err) {
        const kind = classify(err);
        if (kind === "cancelled") throw new LlmError("model request cancelled");
        if (kind === "timeout") {
          throw new LlmError(`Anthropic request failed: timed out after ${config.llmTimeoutMs / 1000} s`);
        }
        if (kind === "retry" && i < BACKOFF_MS.length) continue;
        // Report only the status, never err.message (could echo request details).
        const status = err?.status ? `HTTP ${err.status}` : "request failed";
        throw new LlmError(`Anthropic request failed: ${status}`);
      }
    }
  }

  return {
    async complete(prompt, schema, { signal } = {}) {
      const msg = await request(prompt, schema, signal);
      if (msg.stop_reason === "refusal") throw new LlmError("model declined");
      return (msg.content ?? [])
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("");
    },
  };
}
