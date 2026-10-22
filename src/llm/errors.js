/** Error from a model provider. The message is safe to show: it never contains the API key. */
export class LlmError extends Error {
  constructor(message) {
    super(message);
    this.name = "LlmError";
  }
}
