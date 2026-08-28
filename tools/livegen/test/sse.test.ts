import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DONE, parseDelta, SseParser, StreamProtocolError } from '../src/sse.ts';

const enc = new TextEncoder();
const feed = (parser: SseParser, s: string) => parser.push(enc.encode(s));

function contentOf(parser: SseParser, s: string): string {
  return feed(parser, s)
    .map((e) => parseDelta(e))
    .filter((d): d is Exclude<ReturnType<typeof parseDelta>, null | typeof DONE> => d !== null && d !== DONE)
    .map((d) => d.content)
    .join('');
}

function chunk(content: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] })}\n\n`;
}

test('parses a single complete event', () => {
  const parser = new SseParser();
  assert.equal(contentOf(parser, chunk('hello')), 'hello');
});

test('parses several events arriving in one chunk', () => {
  const parser = new SseParser();
  assert.equal(contentOf(parser, chunk('a') + chunk('b') + chunk('c')), 'abc');
});

test('reassembles an event split across chunk boundaries', () => {
  const parser = new SseParser();
  const payload = chunk('split me');
  let got = '';
  // One byte at a time is the worst realistic case.
  for (const ch of payload) got += contentOf(parser, ch);
  assert.equal(got, 'split me');
});

test('reassembles JSON split mid-string', () => {
  const parser = new SseParser();
  const payload = chunk('function debounce() {}');
  const mid = Math.floor(payload.length / 2);
  let got = contentOf(parser, payload.slice(0, mid));
  got += contentOf(parser, payload.slice(mid));
  assert.equal(got, 'function debounce() {}');
});

test('handles multi-byte characters split across chunks', () => {
  const parser = new SseParser();
  const payload = chunk('glyph \u25B8 and \u{1FA90}');
  const bytes = enc.encode(payload);

  let got = '';
  // Three-byte slices guarantee a codepoint is torn.
  for (let i = 0; i < bytes.length; i += 3) {
    got += parser
      .push(bytes.slice(i, i + 3))
      .map((e) => parseDelta(e))
      .filter((d) => d !== null && d !== DONE)
      .map((d) => (d as { content: string }).content)
      .join('');
  }
  assert.equal(got, 'glyph \u25B8 and \u{1FA90}');
});

test('ignores comment and keep-alive lines', () => {
  const parser = new SseParser();
  const got = contentOf(parser, `: ping\n\n${chunk('x')}: keep-alive\n\n${chunk('y')}`);
  assert.equal(got, 'xy');
});

test('accepts CRLF line endings', () => {
  const parser = new SseParser();
  const payload = (chunk('a') + chunk('b')).replace(/\n/g, '\r\n');
  assert.equal(contentOf(parser, payload), 'ab');
});

test('preserves leading indentation in streamed code', () => {
  const parser = new SseParser();
  // Exactly one space after the colon is protocol framing; the rest is content.
  const got = contentOf(parser, chunk('    indented'));
  assert.equal(got, '    indented');
});

test('preserves a content value that is only whitespace', () => {
  const parser = new SseParser();
  assert.equal(contentOf(parser, chunk('  ')), '  ');
});

test('recognises the DONE sentinel', () => {
  const parser = new SseParser();
  const [event] = feed(parser, 'data: [DONE]\n\n');
  assert.ok(event);
  assert.equal(parseDelta(event), DONE);
});

test('flushes a trailing event with no terminating blank line', () => {
  const parser = new SseParser();
  assert.deepEqual(feed(parser, `data: ${JSON.stringify({ choices: [{ delta: { content: 'tail' } }] })}`), []);
  const events = parser.end();
  assert.equal(events.length, 1);
  const delta = parseDelta(events[0]!);
  assert.equal(delta !== DONE && delta !== null && delta.content, 'tail');
});

test('throws a typed error on a provider error frame', () => {
  const parser = new SseParser();
  const [event] = feed(parser, `data: ${JSON.stringify({ error: { message: 'too long', code: 'ctx' } })}\n\n`);
  assert.ok(event);
  assert.throws(() => parseDelta(event), (err: unknown) => {
    assert.ok(err instanceof StreamProtocolError);
    assert.match(err.message, /too long/);
    assert.match(err.message, /ctx/);
    return true;
  });
});

test('throws a typed error on non-JSON data', () => {
  const parser = new SseParser();
  const [event] = feed(parser, 'data: <html>502 Bad Gateway</html>\n\n');
  assert.ok(event);
  assert.throws(() => parseDelta(event), StreamProtocolError);
});

test('reads reasoning under either field name', () => {
  const parser = new SseParser();
  const a = feed(parser, `data: ${JSON.stringify({ choices: [{ delta: { reasoning: 'think' } }] })}\n\n`);
  const b = feed(parser, `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: 'more' } }] })}\n\n`);
  const first = parseDelta(a[0]!);
  const second = parseDelta(b[0]!);
  assert.equal(first !== DONE && first !== null && first.reasoning, 'think');
  assert.equal(second !== DONE && second !== null && second.reasoning, 'more');
});

test('extracts usage from a trailing frame with no choices', () => {
  const parser = new SseParser();
  const [event] = feed(
    parser,
    `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 42 } })}\n\n`,
  );
  const delta = parseDelta(event!);
  assert.deepEqual(delta !== DONE && delta !== null && delta.usage, {
    promptTokens: 10,
    completionTokens: 42,
  });
});

test('reports finish_reason', () => {
  const parser = new SseParser();
  const [event] = feed(parser, `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'length' }] })}\n\n`);
  const delta = parseDelta(event!);
  assert.equal(delta !== DONE && delta !== null && delta.finishReason, 'length');
});

test('empty data frames are skipped rather than throwing', () => {
  const parser = new SseParser();
  const [event] = feed(parser, 'data:\n\n');
  assert.ok(event);
  assert.equal(parseDelta(event), null);
});


test('a provider error frame is a ProviderError, not a bare protocol error', async () => {
  const { ProviderError } = await import('../src/sse.ts');
  const parser = new SseParser();
  const [event] = feed(parser, `data: ${JSON.stringify({ error: { message: 'nope', code: 'ctx' } })}\n\n`);
  assert.throws(() => parseDelta(event!), (err: unknown) => {
    // ProviderError means the endpoint spoke the protocol and reported a
    // failure. Malformed output is the opposite case and must stay distinct.
    assert.ok(err instanceof ProviderError);
    assert.equal(err.code, 'ctx');
    return true;
  });
});

test('malformed JSON is a protocol error but NOT a provider error', async () => {
  const { ProviderError } = await import('../src/sse.ts');
  const parser = new SseParser();
  const [event] = feed(parser, 'data: <html>502</html>\n\n');
  assert.throws(() => parseDelta(event!), (err: unknown) => {
    assert.ok(err instanceof StreamProtocolError);
    assert.ok(!(err instanceof ProviderError), 'must not be classified as a provider error');
    return true;
  });
});
