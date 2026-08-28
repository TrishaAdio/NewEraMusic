/**
 * Streaming client for OpenAI-compatible chat completions.
 *
 * Deliberately provider-agnostic: the base URL is configuration, so the same
 * code works against OpenAI, Azure, OpenRouter, Groq, a local llama.cpp server,
 * or any reseller panel. Nothing here is specific to one vendor, which matters
 * because endpoints of this kind get revoked and replaced.
 */

import { DONE, parseDelta, SseParser, StreamProtocolError, type Delta } from './sse.ts';
import type { Config } from './config.ts';

export interface Message {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface StreamHandlers {
  /** Fired once, when the first content byte arrives. Measures TTFT. */
  onFirstToken?: () => void;
  onContent?: (text: string) => void;
  onReasoning?: (text: string) => void;
  onUsage?: (usage: { promptTokens: number; completionTokens: number }) => void;
  onFinish?: (reason: string | null) => void;
}

export class HttpError extends Error {
  // Declared and assigned explicitly rather than as constructor parameter
  // properties: those require code generation, and this project runs directly
  // under `node --experimental-strip-types`, which only erases types.
  readonly status: number;
  readonly body: string;

  constructor(status: number, body: string) {
    super(`HTTP ${status}: ${body.slice(0, 400)}`);
    this.status = status;
    this.body = body;
  }
}

export class StallError extends Error {}

/**
 * Streams a completion, invoking handlers as data arrives, and resolves with the
 * assembled text.
 *
 * A stall watchdog is used rather than a total-request timeout: long generations
 * are legitimate, a silent connection is not. Distinguishing the two is the
 * difference between killing a working request and hanging forever on a dead
 * one.
 */
export async function streamCompletion(
  config: Config,
  messages: Message[],
  handlers: StreamHandlers = {},
  signal?: AbortSignal,
): Promise<{ content: string; reasoning: string }> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });

  let stallTimer: NodeJS.Timeout | undefined;
  let stalled = false;
  const resetStall = () => {
    clearTimeout(stallTimer);
    stallTimer = setTimeout(() => {
      stalled = true;
      controller.abort();
    }, config.stallTimeoutMs);
  };

  const body: Record<string, unknown> = {
    model: config.model,
    messages,
    stream: true,
    temperature: config.temperature,
    // Ask for token counts in the final frame. Providers that do not support
    // this ignore it, so it is safe to always send.
    stream_options: { include_usage: true },
  };
  if (config.maxTokens !== null) body.max_tokens = config.maxTokens;

  resetStall();

  let response: Response;
  try {
    response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.apiKey}`,
        accept: 'text/event-stream',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(stallTimer);
    signal?.removeEventListener('abort', abort);
    if (stalled) throw new StallError(`No response within ${config.stallTimeoutMs}ms`);
    throw err;
  }

  if (!response.ok) {
    clearTimeout(stallTimer);
    signal?.removeEventListener('abort', abort);
    throw new HttpError(response.status, await response.text().catch(() => '<unreadable>'));
  }
  if (!response.body) {
    clearTimeout(stallTimer);
    signal?.removeEventListener('abort', abort);
    throw new StreamProtocolError('Response had no body; is stream:true supported?');
  }

  const parser = new SseParser();
  const content: string[] = [];
  const reasoning: string[] = [];
  let sawFirstToken = false;

  const consume = (delta: Delta): boolean => {
    if (delta.content) {
      if (!sawFirstToken) {
        sawFirstToken = true;
        handlers.onFirstToken?.();
      }
      content.push(delta.content);
      handlers.onContent?.(delta.content);
    }
    if (delta.reasoning) {
      reasoning.push(delta.reasoning);
      handlers.onReasoning?.(delta.reasoning);
    }
    if (delta.usage) handlers.onUsage?.(delta.usage);
    if (delta.finishReason) {
      handlers.onFinish?.(delta.finishReason);
      return true;
    }
    return false;
  };

  try {
    const reader = response.body.getReader();
    reading: while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      resetStall();

      for (const event of parser.push(value)) {
        const delta = parseDelta(event);
        if (delta === DONE) break reading;
        if (delta === null) continue;
        // A finish_reason may arrive before [DONE]; keep draining so trailing
        // usage frames are not lost.
        consume(delta);
      }
    }

    for (const event of parser.end()) {
      const delta = parseDelta(event);
      if (delta === DONE || delta === null) continue;
      consume(delta);
    }
  } catch (err) {
    if (stalled) {
      throw new StallError(`Stream produced nothing for ${config.stallTimeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(stallTimer);
    signal?.removeEventListener('abort', abort);
  }

  return { content: content.join(''), reasoning: reasoning.join('') };
}
