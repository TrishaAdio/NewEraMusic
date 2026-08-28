/**
 * Configuration is parsed and validated exactly once, at boot, and the process
 * refuses to start if anything is wrong.
 *
 * The reference implementations read `os.environ` lazily from inside request
 * handlers, so a missing API key surfaces as a stack trace hours later when a
 * user happens to request a Spotify link. Here it is a startup failure with a
 * list of every problem at once.
 */

import { z } from 'zod';

const csvNumbers = z
  .string()
  .default('')
  .transform((raw) =>
    raw
      .split(/[,\s]+/)
      .filter(Boolean)
      .map((part) => {
        const n = Number(part);
        if (!Number.isInteger(n)) throw new Error(`"${part}" is not an integer id`);
        return n;
      }),
  );

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),

  /** From @BotFather. */
  BOT_TOKEN: z.string().min(20, 'BOT_TOKEN looks truncated'),

  /**
   * Streaming into a group call requires a user account, not a bot account —
   * this is a Telegram protocol constraint, not a design choice. Generate the
   * string session with `pnpm session`.
   */
  TG_API_ID: z.coerce.number().int().positive(),
  TG_API_HASH: z.string().length(32, 'TG_API_HASH must be 32 hex characters'),
  TG_SESSION: z.string().min(1, 'run `pnpm session` to generate TG_SESSION'),

  DATABASE_URL: z.string().startsWith('postgres'),
  REDIS_URL: z.string().startsWith('redis'),

  /** Address of the Go voice sidecar. */
  VOICE_ADDR: z.string().default('127.0.0.1:50051'),

  OWNER_IDS: csvNumbers,
  LOG_CHAT_ID: z.coerce.number().int().optional(),

  SPOTIFY_CLIENT_ID: z.string().optional(),
  SPOTIFY_CLIENT_SECRET: z.string().optional(),

  /** Path to a cookies.txt for yt-dlp. Required in practice for YouTube. */
  YTDLP_COOKIES: z.string().optional(),

  /** Leave a call after this many seconds with no other participants. */
  AUTOLEAVE_SECONDS: z.coerce.number().int().min(10).default(60),
  MAX_QUEUE_LENGTH: z.coerce.number().int().min(1).default(200),
  MAX_TRACK_SECONDS: z.coerce.number().int().min(60).default(4 * 60 * 60),
});

export type Config = z.infer<typeof schema>;

let cached: Config | null = null;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  if (cached) return cached;

  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    // Report every problem at once. Fixing config one restart at a time is
    // needlessly slow.
    const lines = parsed.error.issues.map(
      (issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`,
    );
    throw new Error(`Invalid configuration:\n${lines.join('\n')}`);
  }

  if (parsed.data.SPOTIFY_CLIENT_ID && !parsed.data.SPOTIFY_CLIENT_SECRET) {
    throw new Error('SPOTIFY_CLIENT_ID is set but SPOTIFY_CLIENT_SECRET is missing');
  }

  cached = parsed.data;
  return cached;
}

/** Test-only. */
export function resetConfig(): void {
  cached = null;
}

export function isSpotifyEnabled(config: Config): boolean {
  return Boolean(config.SPOTIFY_CLIENT_ID && config.SPOTIFY_CLIENT_SECRET);
}
