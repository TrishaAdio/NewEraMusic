/**
 * A local mock of an OpenAI-compatible streaming endpoint.
 *
 * Exists so the client can be verified without a real API key, and — more
 * usefully — so failure modes a live endpoint will not reproduce on demand can
 * be tested deterministically:
 *
 *   /v1            normal stream, frames split at hostile offsets
 *   /v1-split      every frame chopped into 3-byte writes
 *   /v1-error      fails mid-stream with an error frame, after valid content
 *   /v1-stall      sends a little, then goes silent forever
 *   /v1-http-500   fails before the stream starts
 *   /v1-crlf       CRLF line endings and keep-alive comments
 *   /v1-unicode    multi-byte characters split across chunk boundaries
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

const SAMPLE = `Here is a debounce implementation.

\`\`\`typescript
export function debounce<A extends unknown[]>(
  fn: (...args: A) => void,
  waitMs: number,
): (...args: A) => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return (...args: A) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), waitMs);
  };
}
\`\`\`

The timer is captured per closure, so each debounced function is independent.
`;

const UNICODE_SAMPLE = 'Glyphs: \u25B8 \u25AA \u2219 \u2502 \u25C8 \u27E1 and an emoji \u{1FA90} done.\n';

function frame(content: string): string {
  return `data: ${JSON.stringify({
    id: 'chatcmpl-mock',
    object: 'chat.completion.chunk',
    model: 'mock-model',
    choices: [{ index: 0, delta: { content }, finish_reason: null }],
  })}\n\n`;
}

function finishFrame(completionTokens: number): string {
  const stop = `data: ${JSON.stringify({
    id: 'chatcmpl-mock',
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
  })}\n\n`;
  const usage = `data: ${JSON.stringify({
    id: 'chatcmpl-mock',
    object: 'chat.completion.chunk',
    choices: [],
    usage: { prompt_tokens: 24, completion_tokens: completionTokens, total_tokens: 24 + completionTokens },
  })}\n\n`;
  return stop + usage + 'data: [DONE]\n\n';
}

/** Splits into token-ish pieces so the stream looks like real generation. */
function tokenise(text: string): string[] {
  return text.match(/\s*\S+|\s+/g) ?? [];
}

function sseHeaders(res: ServerResponse): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function writeSlowly(res: ServerResponse, payload: string, sliceSize: number, delayMs: number) {
  for (let i = 0; i < payload.length; i += sliceSize) {
    res.write(payload.slice(i, i + sliceSize));
    await sleep(delayMs);
  }
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = req.url ?? '';

  if (!url.includes('/chat/completions')) {
    res.writeHead(404).end('not found');
    return;
  }

  // Authorization is required so the client's header wiring is actually
  // exercised; the value is never inspected beyond being present.
  if (!req.headers.authorization?.startsWith('Bearer ')) {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'missing bearer token', code: 'unauthorized' } }));
    return;
  }

  if (url.startsWith('/v1-http-500')) {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'upstream capacity exceeded', code: 'overloaded' } }));
    return;
  }

  if (url.startsWith('/v1-stall')) {
    sseHeaders(res);
    res.write(frame('Starting to think'));
    // Never writes again and never ends. The client must time this out.
    return;
  }

  if (url.startsWith('/v1-error')) {
    sseHeaders(res);
    res.write(frame('Here is the first part'));
    await sleep(30);
    res.write(
      `data: ${JSON.stringify({ error: { message: 'context length exceeded', code: 'context_length' } })}\n\n`,
    );
    res.end();
    return;
  }

  if (url.startsWith('/v1-crlf')) {
    sseHeaders(res);
    res.write(': ping\r\n\r\n');
    for (const tok of tokenise(SAMPLE).slice(0, 12)) {
      res.write(frame(tok).replace(/\n/g, '\r\n'));
      await sleep(4);
    }
    res.write(': keep-alive\r\n\r\n');
    res.write(finishFrame(12).replace(/\n/g, '\r\n'));
    res.end();
    return;
  }

  if (url.startsWith('/v1-unicode')) {
    sseHeaders(res);
    const payload = tokenise(UNICODE_SAMPLE).map(frame).join('') + finishFrame(9);
    // 3-byte slices guarantee multi-byte characters land across boundaries.
    await writeSlowly(res, payload, 3, 1);
    res.end();
    return;
  }

  if (url.startsWith('/v1-split')) {
    sseHeaders(res);
    const split = tokenise(SAMPLE);
    const payload = split.map(frame).join('') + finishFrame(split.length);
    await writeSlowly(res, payload, 3, 0);
    res.end();
    return;
  }

  // Default: a normal-looking stream at a plausible rate.
  sseHeaders(res);
  const tokens = tokenise(SAMPLE);
  for (const tok of tokens) {
    res.write(frame(tok));
    await sleep(12);
  }
  res.write(finishFrame(tokens.length));
  res.end();
}

const port = Number(process.env.MOCK_PORT ?? 8787);

export const server = createServer((req, res) => {
  handle(req, res).catch((err) => {
    console.error('mock handler failed', err);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  });
});

if (process.argv[1]?.includes('mock/server')) {
  server.listen(port, '127.0.0.1', () => {
    console.log(`mock endpoint on http://127.0.0.1:${port}`);
    console.log('routes: /v1  /v1-split  /v1-error  /v1-stall  /v1-http-500  /v1-crlf  /v1-unicode');
  });
}
