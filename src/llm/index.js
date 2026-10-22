/**
 * Model providers behind one interface: complete(prompt, schema) -> final text.
 */
import { LlmError } from "./errors.js";
import { createOpenAi } from "./openai.js";
import { createAnthropic } from "./anthropic.js";

export { LlmError };

/**
 * @param {object} config  Config from loadConfig
 * @param {{fetchImpl?: typeof fetch, anthropicClient?: object, sleep?: (ms:number)=>Promise<void>}} [opts]
 * @returns {{complete(prompt: string, schema: object, opts?: {signal?: AbortSignal}): Promise<string>}}
 */
export function createLlm(config, { fetchImpl, anthropicClient, sleep } = {}) {
  return config.llmProvider === "anthropic"
    ? createAnthropic(config, { anthropicClient, sleep })
    : createOpenAi(config, { fetchImpl, sleep });
}
