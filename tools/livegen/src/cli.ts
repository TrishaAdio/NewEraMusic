#!/usr/bin/env node
/**
 * Entry point. Reads a prompt from argv or stdin, streams the completion, and
 * renders it live.
 *
 *   livegen "write a debounce function in typescript"
 *   echo "refactor this" | livegen
 *   LLM_OUT_FILE=out.ts livegen "write a rate limiter"
 */

import { writeFile } from 'node:fs/promises';
import { ConfigError, loadConfig, maskKey } from './config.ts';
import { extractCode, LiveRenderer } from './render.ts';
import { HttpError, StallError, streamCompletion, type Message } from './stream.ts';
import { ProviderError, StreamProtocolError } from './sse.ts';

const SYSTEM_PROMPT = `You are a senior engineer. Answer with working code.
Put all code in fenced blocks with a language tag. Keep prose to at most two
sentences before and after the code. Do not use italic formatting.`;

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8').trim();
}

async function main(): Promise<number> {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`${err.message}\n\nCopy .env.example to .env and fill it in.\n`);
      return 78; // EX_CONFIG
    }
    throw err;
  }

  const argPrompt = process.argv.slice(2).join(' ').trim();
  const prompt = argPrompt || (await readStdin());
  if (!prompt) {
    process.stderr.write('Usage: livegen "<prompt>"   (or pipe the prompt on stdin)\n');
    return 64; // EX_USAGE
  }

  const renderer = new LiveRenderer();
  const messages: Message[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: prompt },
  ];

  // Ctrl-C aborts the request rather than killing the process mid-write, so the
  // stats line and any output file still get written.
  const controller = new AbortController();
  process.on('SIGINT', () => controller.abort());

  process.stderr.write(`key ${maskKey(config.apiKey)}\n`);
  renderer.start(config.model, config.baseUrl);

  let finishReason: string | null = null;

  try {
    const { content } = await streamCompletion(
      config,
      messages,
      {
        onContent: (text) => renderer.push(text),
        onUsage: (usage) => renderer.setUsage(usage.completionTokens),
        onFinish: (reason) => {
          finishReason = reason;
        },
      },
      controller.signal,
    );

    renderer.finish(finishReason);

    if (config.outFile) {
      const { code, lang } = extractCode(content);
      await writeFile(config.outFile, code.endsWith('\n') ? code : `${code}\n`, 'utf8');
      process.stderr.write(
        `wrote ${code.split('\n').length} lines${lang ? ` of ${lang}` : ''} to ${config.outFile}\n`,
      );
    }

    return 0;
  } catch (err) {
    if (controller.signal.aborted && !(err instanceof StallError)) {
      renderer.error('aborted');
      return 130;
    }
    if (err instanceof HttpError) {
      // 401/403 here is the common case with resold keys: revoked upstream.
      const hint =
        err.status === 401 || err.status === 403
          ? ' — key rejected; it may be revoked or out of quota'
          : err.status === 404
            ? ' — check LLM_BASE_URL and LLM_MODEL'
            : err.status === 429
              ? ' — rate limited'
              : '';
      renderer.error(`${err.message}${hint}`);
      return 1;
    }
    if (err instanceof StallError) {
      renderer.error(`${err.message} — raise LLM_STALL_TIMEOUT_MS if the model is just slow`);
      return 1;
    }
    // Order matters: ProviderError extends StreamProtocolError. A provider error
    // proves the endpoint IS compatible, so it must not get the opposite hint.
    if (err instanceof ProviderError) {
      const hint =
        err.code === 'context_length' || /context/i.test(err.message)
          ? ' — shorten the prompt or lower LLM_MAX_TOKENS'
          : '';
      renderer.error(`${err.message}${hint}`);
      return 1;
    }
    if (err instanceof StreamProtocolError) {
      renderer.error(`${err.message} — endpoint may not be OpenAI-compatible`);
      return 1;
    }
    renderer.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
    process.exit(1);
  },
);
