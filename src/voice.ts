import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { DATA_DIR } from './config.js';
import { settingsStore } from './db.js';

/**
 * Big Dog's voice — text-to-speech for phone calls + voicemails, with built-in
 * voices and the option to clone your own.
 *
 * Built on a pluggable, OpenAI-compatible TTS endpoint (`/v1/audio/speech`), so
 * you can point it at the best open-source engines from
 * github.com/wildminder/awesome-ai-voice running as a local server:
 *   • Kokoro (Apache-2.0, CPU-friendly) — high-quality BUILT-IN voices
 *     → Kokoro-FastAPI exposes the OpenAI API out of the box
 *   • Chatterbox (Resemble AI, MIT) — zero-shot VOICE CLONING from a sample
 *   • openedai-speech — wraps Piper + Coqui/XTTS with the same API
 *   • or OpenAI's hosted TTS
 * Big Dog generates the audio, hosts it, and Twilio plays it on the call.
 */

export const VOICE_DIR = resolve(DATA_DIR, 'voice');

export interface VoiceSettings {
  provider: 'off' | 'openai';
  baseUrl: string; // e.g. http://tts:8880/v1  or  https://api.openai.com/v1
  apiKey: string;
  model: string; // e.g. kokoro | tts-1 | chatterbox
  voice: string; // selected voice name
  cloneName: string; // a cloned-voice name registered on your TTS server
}

const KEYS: (keyof VoiceSettings)[] = ['provider', 'baseUrl', 'apiKey', 'model', 'voice', 'cloneName'];

/** A few solid built-in voices (Kokoro names; works with Kokoro-FastAPI). */
export const BUILTIN_VOICES = [
  { id: 'af_heart', label: 'Aria — warm female (US)' },
  { id: 'af_bella', label: 'Bella — bright female (US)' },
  { id: 'am_michael', label: 'Michael — steady male (US)' },
  { id: 'am_adam', label: 'Adam — deep male (US)' },
  { id: 'bf_emma', label: 'Emma — female (UK)' },
  { id: 'bm_george', label: 'George — male (UK)' },
];

export function loadVoiceSettings(): VoiceSettings {
  return {
    provider: (settingsStore.get('voice.provider') as VoiceSettings['provider']) || (process.env.VOICE_PROVIDER as VoiceSettings['provider']) || 'off',
    baseUrl: settingsStore.get('voice.baseUrl') || process.env.VOICE_BASE_URL || '',
    apiKey: settingsStore.get('voice.apiKey') || process.env.VOICE_API_KEY || '',
    model: settingsStore.get('voice.model') || process.env.VOICE_MODEL || 'kokoro',
    voice: settingsStore.get('voice.voice') || process.env.VOICE_NAME || 'af_heart',
    cloneName: settingsStore.get('voice.cloneName') || '',
  };
}

export function saveVoiceSettings(p: Partial<Record<keyof VoiceSettings, unknown>>): void {
  for (const k of KEYS) {
    const v = p[k];
    if (v === undefined || v === null) continue;
    settingsStore.set(`voice.${k}`, String(v).trim());
  }
}

export function voiceConfigured(s: VoiceSettings = loadVoiceSettings()): boolean {
  return s.provider === 'openai' && !!s.baseUrl && !!s.model;
}

export function publicVoice(s: VoiceSettings = loadVoiceSettings()) {
  return {
    configured: voiceConfigured(s), provider: s.provider, baseUrl: s.baseUrl, model: s.model,
    voice: s.voice, cloneName: s.cloneName, apiKeySet: !!s.apiKey,
    sampleSet: existsSync(resolve(VOICE_DIR, 'sample.wav')),
    builtins: BUILTIN_VOICES,
  };
}

function ensureDir() { if (!existsSync(VOICE_DIR)) mkdirSync(VOICE_DIR, { recursive: true }); }

/** Synthesize speech to an mp3 file under VOICE_DIR; returns the file id. */
export async function synthesize(text: string, voiceOverride?: string, s: VoiceSettings = loadVoiceSettings()): Promise<{ id: string; path: string }> {
  if (!voiceConfigured(s)) throw new Error('Voice not configured.');
  const url = s.baseUrl.replace(/\/$/, '') + '/audio/speech';
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(s.apiKey ? { Authorization: `Bearer ${s.apiKey}` } : {}) },
    body: JSON.stringify({ model: s.model, input: text.slice(0, 3000), voice: voiceOverride || s.voice, response_format: 'mp3' }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`TTS ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
  ensureDir();
  const id = randomUUID().slice(0, 16);
  const path = resolve(VOICE_DIR, `${id}.mp3`);
  writeFileSync(path, Buffer.from(await res.arrayBuffer()));
  return { id, path };
}

/** Store a voice sample for cloning (the engine clones from this). */
export function saveVoiceSample(base64: string, _mime = 'audio/wav'): { ok: boolean } {
  ensureDir();
  writeFileSync(resolve(VOICE_DIR, 'sample.wav'), Buffer.from(base64, 'base64'));
  return { ok: true };
}

export function voiceFilePath(id: string): string {
  return resolve(VOICE_DIR, `${id.replace(/[^a-zA-Z0-9-]/g, '')}.mp3`);
}

export async function testVoice(s: VoiceSettings = loadVoiceSettings()): Promise<{ ok: boolean; detail: string }> {
  if (!voiceConfigured(s)) return { ok: false, detail: 'Set the TTS endpoint + model first.' };
  try {
    await synthesize("What's up, Big Dog!", undefined, s);
    return { ok: true, detail: `Voice ready (${s.model} · ${s.voice})` };
  } catch (err) {
    return { ok: false, detail: (err as Error).message };
  }
}
