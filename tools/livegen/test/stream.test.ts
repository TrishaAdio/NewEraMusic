/**
 * End-to-end tests against the local mock endpoint. These cover the failure
 * modes a real provider will not reproduce on demand.
 */

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { AddressInfo } from 'node:net';

import { server } from '../mock/server.ts';
import { HttpError, StallError, streamCompletion } from '../src/stream.ts';
import { StreamProtocolError } from '../src/sse.ts';
import type { Config } from '../src/config.ts';

let base = '';

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;
});

after(() => {
  server.close();
});

function config(route: string, overrides: Partial<Config> = {}): Config {
  return {
    baseUrl: `${base}${route}`,
    apiKey: 'test-key-not-real',
    model: 'mock-model',
    temperature: 0.2,
    maxTokens: null,
    stallTimeoutMs: 60_000,
    outFile: null,
    ...overrides,
  };
}

const ask = [{ role: 'user' as const, content: 'write debounce' }];

test('streams a normal completion and assembles the full text', async () => {
  const chunks: string[] = [];
  let usage: number | null = null;
  let finish: string | null = null;
  let ttftFired = false;

  const { content } = await streamCompletion(config('/v1'), ask, {
    onFirstToken: () => {
      ttftFired = true;
    },
    onContent: (t) => chunks.push(t),
    onUsage: (u) => {
      usage = u.completionTokens;
    },
    onFinish: (r) => {
      finish = r;
    },
  });

  assert.ok(ttftFired, 'first-token callback should fire');
  assert.ok(chunks.length > 10, `expected many deltas, got ${chunks.length}`);
  assert.equal(chunks.join(''), content, 'assembled text must equal concatenated deltas');
  assert.match(content, /export function debounce/);
  assert.match(content, /```typescript/);
  assert.equal(finish, 'stop');
  // Derived, not hardcoded: the mock reports one token per content delta, so
  // usage must agree with the number of deltas actually observed.
  assert.equal(usage, chunks.length, 'reported usage should match delta count');
});

test('survives every frame being split into 3-byte writes', async () => {
  const { content } = await streamCompletion(config('/v1-split'), ask);
  assert.match(content, /export function debounce/);
  assert.match(content, /clearTimeout\(timer\)/);
  // Indentation must survive, or streamed code is unusable.
  assert.match(content, /\n  let timer:/);
});

test('reassembles multi-byte characters torn across chunks', async () => {
  const { content } = await streamCompletion(config('/v1-unicode'), ask);
  assert.match(content, /\u25B8/);
  assert.match(content, /\u{1FA90}/u);
  assert.ok(!content.includes('\uFFFD'), 'must not contain replacement characters');
});

test('handles CRLF framing and keep-alive comments', async () => {
  const { content } = await streamCompletion(config('/v1-crlf'), ask);
  assert.ok(content.length > 0);
  assert.ok(!content.includes('ping'), 'keep-alive comments must not leak into content');
});

test('surfaces a mid-stream provider error as StreamProtocolError', async () => {
  await assert.rejects(
    streamCompletion(config('/v1-error'), ask),
    (err: unknown) => {
      assert.ok(err instanceof StreamProtocolError);
      assert.match(err.message, /context length exceeded/);
      return true;
    },
  );
});

test('surfaces a pre-stream failure as HttpError with the status', async () => {
  await assert.rejects(streamCompletion(config('/v1-http-500'), ask), (err: unknown) => {
    assert.ok(err instanceof HttpError);
    assert.equal(err.status, 500);
    assert.match(err.body, /capacity exceeded/);
    return true;
  });
});

test('rejects with 401 when the bearer header is missing', async () => {
  await assert.rejects(streamCompletion(config('/v1', { apiKey: '' }), ask), (err: unknown) => {
    assert.ok(err instanceof HttpError);
    assert.equal(err.status, 401);
    return true;
  });
});

test('aborts a silent stream via the stall watchdog', async () => {
  const started = Date.now();
  await assert.rejects(
    streamCompletion(config('/v1-stall', { stallTimeoutMs: 300 }), ask),
    (err: unknown) => {
      assert.ok(err instanceof StallError, `expected StallError, got ${String(err)}`);
      return true;
    },
  );
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 3_000, `should give up promptly, took ${elapsed}ms`);
});

test('an external abort signal stops the stream', async () => {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 40);
  await assert.rejects(streamCompletion(config('/v1'), ask, {}, controller.signal));
});
