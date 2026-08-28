/**
 * Server-Sent Events parser for OpenAI-compatible streaming responses.
 *
 * This is the part naive implementations get wrong. A chunk boundary from the
 * network has no relationship to a message boundary in the protocol, so all of
 * the following happen in practice and all of them must work:
 *
 *   - a single `data:` line split across two or more chunks
 *   - several complete events arriving inside one chunk
 *   - a JSON payload split mid-string, mid-escape, or mid-surrogate-pair
 *   - `\r\n` line endings from proxies that normalise them
 *   - comment/keep-alive lines (`: ping`) that must be ignored, not parsed
 *   - `data: [DONE]` as a sentinel that is deliberately not JSON
 *
 * Splitting a UTF-8 multi-byte character across chunks is handled by decoding
 * with a streaming TextDecoder rather than per-chunk `toString()`.
 */

export interface SseEvent {
  /** The `event:` field, when the server sends one. */
  event: string | null;
  /** Joined `data:` lines, newline-separated, as the spec requires. */
  data: string;
}

/**
 * Incremental parser. Feed it bytes, get back complete events. Holds only the
 * unterminated tail between calls.
 */
export class SseParser {
  private buffer = '';
  private readonly decoder = new TextDecoder('utf-8');

  /** Feeds a chunk and returns every event that became complete. */
  push(chunk: Uint8Array): SseEvent[] {
    // `stream: true` keeps partial multi-byte sequences in the decoder rather
    // than emitting U+FFFD for them.
    this.buffer += this.decoder.decode(chunk, { stream: true });
    return this.drain();
  }

  /** Flushes any trailing event not terminated by a blank line. */
  end(): SseEvent[] {
    this.buffer += this.decoder.decode();
    const events = this.drain();
    const tail = this.buffer.trim();
    this.buffer = '';
    if (tail === '') return events;
    const parsed = parseBlock(tail);
    return parsed ? [...events, parsed] : events;
  }

  private drain(): SseEvent[] {
    const events: SseEvent[] = [];

    // Events are separated by a blank line. Normalise CRLF first so a single
    // split rule covers both wire formats.
    this.buffer = this.buffer.replace(/\r\n/g, '\n');

    let index: number;
    while ((index = this.buffer.indexOf('\n\n')) !== -1) {
      const block = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 2);
      const parsed = parseBlock(block);
      if (parsed) events.push(parsed);
    }

    return events;
  }
}

function parseBlock(block: string): SseEvent | null {
  let event: string | null = null;
  const dataLines: string[] = [];

  for (const rawLine of block.split('\n')) {
    // A line beginning with a colon is a comment. Keep-alives look like `: ping`
    // and must never reach JSON.parse.
    if (rawLine.startsWith(':')) continue;

    const colon = rawLine.indexOf(':');
    const field = colon === -1 ? rawLine : rawLine.slice(0, colon);
    // Exactly one optional leading space is stripped, per the SSE spec. Stripping
    // all whitespace would corrupt indentation in streamed code.
    let value = colon === -1 ? '' : rawLine.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);

    if (field === 'data') dataLines.push(value);
    else if (field === 'event') event = value;
  }

  if (dataLines.length === 0) return null;
  return { event, data: dataLines.join('\n') };
}

// ---------------------------------------------------------------------------
// OpenAI chat-completion chunk shape
// ---------------------------------------------------------------------------

export interface Delta {
  /** Text content, if this chunk carried any. */
  content: string;
  /** Reasoning/thinking text, which some providers stream on a separate field. */
  reasoning: string;
  finishReason: string | null;
  usage: { promptTokens: number; completionTokens: number } | null;
}

export const DONE = Symbol('done');

/** The stream was not shaped the way an OpenAI-compatible endpoint should be. */
export class StreamProtocolError extends Error {}

/**
 * The endpoint spoke the protocol correctly and reported a failure inside it.
 *
 * Distinguished from StreamProtocolError because the remedies are opposite: this
 * means the request was wrong (too long, filtered, out of quota), whereas a
 * protocol error means the endpoint is wrong.
 */
export class ProviderError extends StreamProtocolError {
  readonly code: string | null;

  constructor(message: string, code: string | null) {
    super(message);
    this.code = code;
  }
}

/**
 * Interprets one SSE event as a chat-completion delta.
 *
 * Returns DONE for the terminal sentinel and null for anything carrying no
 * useful information, so callers do not have to distinguish "not yet" from
 * "malformed" — malformed throws.
 */
export function parseDelta(event: SseEvent): Delta | typeof DONE | null {
  const data = event.data.trim();
  if (data === '') return null;
  if (data === '[DONE]') return DONE;

  let json: unknown;
  try {
    json = JSON.parse(data);
  } catch {
    throw new StreamProtocolError(`Expected JSON in SSE data frame, got: ${truncate(data, 200)}`);
  }

  if (typeof json !== 'object' || json === null) {
    throw new StreamProtocolError(`Expected a JSON object, got ${typeof json}`);
  }

  const obj = json as Record<string, unknown>;

  // Providers report mid-stream failures as a data frame rather than an HTTP
  // status, because headers are long gone by then.
  if (obj.error) {
    const err = obj.error as Record<string, unknown>;
    const message = typeof err.message === 'string' ? err.message : JSON.stringify(err);
    const code = typeof err.code === 'string' ? err.code : null;
    throw new ProviderError(`Provider error${code ? ` (${code})` : ''}: ${message}`, code);
  }

  const choice = Array.isArray(obj.choices) ? (obj.choices[0] as Record<string, unknown>) : undefined;
  const delta = (choice?.delta ?? {}) as Record<string, unknown>;

  const usageRaw = obj.usage as Record<string, unknown> | undefined;

  return {
    content: typeof delta.content === 'string' ? delta.content : '',
    // Field name varies by provider; accept the common spellings.
    reasoning:
      typeof delta.reasoning === 'string'
        ? delta.reasoning
        : typeof delta.reasoning_content === 'string'
          ? delta.reasoning_content
          : '',
    finishReason: typeof choice?.finish_reason === 'string' ? choice.finish_reason : null,
    usage:
      usageRaw && typeof usageRaw.completion_tokens === 'number'
        ? {
            promptTokens: Number(usageRaw.prompt_tokens ?? 0),
            completionTokens: Number(usageRaw.completion_tokens),
          }
        : null,
  };
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}\u2026`;
}
