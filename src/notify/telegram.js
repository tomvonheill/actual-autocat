/**
 * Telegram notifier. Sends plain-text messages; failures are logged, never thrown.
 */

const noop = () => {};
const silent = { debug: noop, info: noop, warn: noop, error: noop };

/**
 * @param {{telegramBotToken: string, telegramChatId: string}} config
 * @param {typeof fetch} [fetchImpl]
 * @param {{debug: Function, info: Function, warn: Function, error: Function}} [log]
 * @returns {{enabled: boolean, send(messages: string[]): Promise<void>}}
 */
export function createTelegram({ telegramBotToken, telegramChatId }, fetchImpl = globalThis.fetch, log = silent) {
  const enabled = Boolean(telegramBotToken && telegramChatId);
  const redact = (s) => String(s).split(telegramBotToken).join("<token>");

  async function send(messages) {
    if (!enabled) return;
    const url = `https://api.telegram.org/bot${telegramBotToken}/sendMessage`;
    for (const text of messages) {
      try {
        const res = await fetchImpl(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ chat_id: telegramChatId, text }),
        });
        if (!res.ok) log.error(`Telegram send failed: HTTP ${res.status}`);
      } catch (err) {
        log.error(`Telegram send failed: ${redact(err?.message ?? err)}`);
      }
    }
  }

  return { enabled, send };
}
