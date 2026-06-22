import { routeMessage, type BotDeps } from './commands.js';

/**
 * Telegram bot via long polling — perfect for running locally: no public URL,
 * no webhooks, just outbound HTTPS to Telegram. Get a token from @BotFather.
 */
export interface TelegramBot {
  notify(text: string): Promise<void>;
}

export async function startTelegram(
  token: string,
  defaultChatId: string,
  deps: BotDeps,
): Promise<TelegramBot> {
  const base = `https://api.telegram.org/bot${token}`;

  async function call<T = unknown>(method: string, body: object): Promise<T> {
    const res = await fetch(`${base}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = (await res.json()) as { ok: boolean; result: T; description?: string };
    if (!data.ok) throw new Error(data.description || `telegram ${method} failed`);
    return data.result;
  }

  async function send(chatId: string | number, text: string): Promise<void> {
    // Telegram caps messages at 4096 chars; chunk long replies.
    for (let i = 0; i < text.length; i += 4000) {
      await call('sendMessage', { chat_id: chatId, text: text.slice(i, i + 4000) }).catch(() => {});
    }
  }

  // Identify the bot for a friendly startup log.
  try {
    const me = await call<{ username: string }>('getMe', {});
    console.log(`[big-dog] Telegram bot live: @${me.username}`);
  } catch (err) {
    console.error('[big-dog] Telegram token rejected:', (err as Error).message);
  }

  // Long-poll loop.
  let offset = 0;
  (async function poll() {
    for (;;) {
      try {
        const updates = await call<
          { update_id: number; message?: { chat: { id: number }; text?: string } }[]
        >('getUpdates', { offset, timeout: 30, allowed_updates: ['message'] });

        for (const u of updates) {
          offset = u.update_id + 1;
          const text = u.message?.text;
          const chatId = u.message?.chat.id;
          if (!text || chatId == null) continue;
          try {
            const reply = await routeMessage(text, deps);
            await send(chatId, reply);
          } catch (err) {
            await send(chatId, `🐕 Hit a snag: ${(err as Error).message}`);
          }
        }
      } catch (err) {
        // Network blip — back off and retry.
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  })();

  return {
    async notify(text: string) {
      if (defaultChatId) await send(defaultChatId, text);
    },
  };
}
