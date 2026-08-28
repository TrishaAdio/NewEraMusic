/**
 * Configuration for the live generation viewer.
 *
 * The API key is read from the environment and nowhere else. It is never a
 * function argument with a default, never a config-file field, and never a CLI
 * flag — flags land in shell history and config files land in commits.
 */

export interface Config {
  /** OpenAI-compatible base URL, without a trailing slash. */
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  maxTokens: number | null;
  /** Abort if the stream produces nothing for this long. */
  stallTimeoutMs: number;
  /** Write the extracted code block here when the stream finishes. */
  outFile: string | null;
}

export class ConfigError extends Error {}

const PLACEHOLDERS = new Set(['', 'your-key', 'sk-xxx', 'changeme', 'todo']);

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const problems: string[] = [];

  const apiKey = (env.LLM_API_KEY ?? '').trim();
  if (PLACEHOLDERS.has(apiKey.toLowerCase())) {
    problems.push('LLM_API_KEY is not set (put it in .env, which is gitignored)');
  }

  const rawBase = (env.LLM_BASE_URL ?? '').trim();
  if (!rawBase) {
    problems.push('LLM_BASE_URL is not set, e.g. https://api.example.com/v1');
  } else if (!/^https?:\/\//.test(rawBase)) {
    problems.push(`LLM_BASE_URL must start with http:// or https://, got "${rawBase}"`);
  } else if (rawBase.startsWith('http://') && !/^http:\/\/(localhost|127\.0\.0\.1)/.test(rawBase)) {
    // Plain HTTP to a remote host would put the key on the wire in cleartext.
    problems.push('LLM_BASE_URL uses http:// to a remote host; the API key would be sent in cleartext');
  }

  const model = (env.LLM_MODEL ?? '').trim();
  if (!model) problems.push('LLM_MODEL is not set, e.g. claude-opus-5');

  const temperature = numeric(env.LLM_TEMPERATURE, 0.2, problems, 'LLM_TEMPERATURE', 0, 2);
  const maxTokens = env.LLM_MAX_TOKENS
    ? numeric(env.LLM_MAX_TOKENS, 4096, problems, 'LLM_MAX_TOKENS', 1, 1_000_000)
    : null;
  const stallTimeoutMs = numeric(env.LLM_STALL_TIMEOUT_MS, 60_000, problems, 'LLM_STALL_TIMEOUT_MS', 1_000, 600_000);

  if (problems.length > 0) {
    throw new ConfigError(`Invalid configuration:\n${problems.map((p) => `  ${p}`).join('\n')}`);
  }

  return {
    baseUrl: rawBase.replace(/\/+$/, ''),
    apiKey,
    model,
    temperature,
    maxTokens,
    stallTimeoutMs,
    outFile: env.LLM_OUT_FILE?.trim() || null,
  };
}

function numeric(
  raw: string | undefined,
  fallback: number,
  problems: string[],
  name: string,
  min: number,
  max: number,
): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    problems.push(`${name} must be a number, got "${raw}"`);
    return fallback;
  }
  if (n < min || n > max) {
    problems.push(`${name} must be between ${min} and ${max}, got ${n}`);
    return fallback;
  }
  return n;
}

/**
 * Masks a key for display. Shows enough to identify which key is loaded without
 * printing anything reusable — logs and screenshots leak constantly.
 */
export function maskKey(key: string): string {
  if (key.length <= 10) return '*'.repeat(key.length);
  return `${key.slice(0, 6)}${'*'.repeat(Math.min(18, key.length - 10))}${key.slice(-4)}`;
}
