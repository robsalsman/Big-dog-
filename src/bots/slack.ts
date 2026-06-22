import { routeMessage, type BotDeps } from './commands.js';
import type { AppConfig } from '../config.js';

/**
 * Slack integration. Two-way chat runs over Socket Mode (a websocket Slack
 * opens for us) using Node's native WebSocket — no public URL, no SDK, no new
 * dependencies. Needs a bot token (xoxb-) and an app-level token (xapp-) with
 * connections:write. If only an incoming-webhook URL is set, Big Dog can still
 * push proactive notifications one-way.
 */
export interface SlackBot {
  notify(text: string): Promise<void>;
}

async function slackApi(token: string, method: string, body: object): Promise<any> {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return res.json();
}

export async function startSlack(slack: NonNullable<AppConfig['slack']>, deps: BotDeps): Promise<SlackBot> {
  const { botToken, appToken, channel, webhookUrl } = slack;

  async function post(toChannel: string, text: string): Promise<void> {
    if (botToken) {
      await slackApi(botToken, 'chat.postMessage', { channel: toChannel, text }).catch(() => {});
    }
  }

  // Two-way chat via Socket Mode (only if both tokens are present).
  if (botToken && appToken) {
    const seen = new Set<string>();
    let botUserId = '';
    try {
      const auth = await slackApi(botToken, 'auth.test', {});
      botUserId = auth.user_id || '';
      console.log(`[big-dog] Slack bot live${auth.user ? `: @${auth.user}` : ''}`);
    } catch {
      /* logged below if connection fails */
    }

    const connect = async (): Promise<void> => {
      const open = await slackApi(appToken, 'apps.connections.open', {});
      if (!open.ok || !open.url) {
        console.error('[big-dog] Slack Socket Mode failed to open:', open.error || 'unknown');
        return;
      }
      const ws = new WebSocket(open.url);

      ws.addEventListener('message', async (ev: MessageEvent) => {
        let frame: any;
        try {
          frame = JSON.parse(typeof ev.data === 'string' ? ev.data : '');
        } catch {
          return;
        }

        if (frame.type === 'disconnect') {
          ws.close();
          return;
        }
        if (frame.type !== 'events_api' && frame.type !== 'slash_commands') return;

        // Ack immediately so Slack doesn't retry.
        if (frame.envelope_id) ws.send(JSON.stringify({ envelope_id: frame.envelope_id }));

        // De-dupe Slack's at-least-once delivery.
        const id = frame.payload?.event_id || frame.envelope_id;
        if (id) {
          if (seen.has(id)) return;
          seen.add(id);
          if (seen.size > 500) seen.clear();
        }

        const event = frame.payload?.event;
        if (!event) return;
        // Ignore the bot's own messages and non-text events.
        if (event.bot_id || event.user === botUserId) return;

        const isMention = event.type === 'app_mention';
        const isDM = event.type === 'message' && event.channel_type === 'im' && !event.subtype;
        if (!isMention && !isDM) return;

        const text = String(event.text || '')
          .replace(/<@[^>]+>/g, '')
          .trim();
        if (!text) return;

        try {
          const reply = await routeMessage(text, deps);
          await post(event.channel, reply);
        } catch (err) {
          await post(event.channel, `🐕 Hit a snag: ${(err as Error).message}`);
        }
      });

      ws.addEventListener('close', () => {
        // Reconnect with a short backoff.
        setTimeout(() => connect().catch(() => {}), 2000);
      });
      ws.addEventListener('error', () => ws.close());
    };

    await connect().catch((err) => console.error('[big-dog] Slack connect error:', (err as Error).message));
  } else if (webhookUrl) {
    console.log('[big-dog] Slack notifications enabled (incoming webhook, one-way)');
  }

  return {
    async notify(text: string) {
      if (botToken && channel) {
        await post(channel, text);
      } else if (webhookUrl) {
        await fetch(webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text }),
        }).catch(() => {});
      }
    },
  };
}
