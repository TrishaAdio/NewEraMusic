import assert from 'node:assert/strict';
import { test } from 'node:test';

import { emptySession, reduce, remainingSeconds, type Session, type Track } from '../src/machine.ts';

function track(id: string, overrides: Partial<Track> = {}): Track {
  return {
    id,
    title: `Track ${id}`,
    durationSec: 180,
    uri: `file:///tmp/${id}.opus`,
    source: 'youtube',
    requestedBy: { id: 1, name: 'tester' },
    isLive: false,
    ...overrides,
  };
}

function play(session: Session, ...tracks: Track[]): Session {
  let s = session;
  for (const t of tracks) s = reduce(s, { type: 'enqueue', track: t }).session;
  return reduce(s, { type: 'joined' }).session;
}

test('first enqueue joins the call instead of queuing', () => {
  const { session, effects } = reduce(emptySession(-100), { type: 'enqueue', track: track('a') });

  assert.equal(session.phase.name, 'joining');
  assert.equal(session.current?.id, 'a');
  assert.equal(session.upcoming.length, 0);
  assert.deepEqual(
    effects.map((e) => e.kind),
    ['join'],
  );
});

test('subsequent enqueues do not re-join', () => {
  const session = play(emptySession(-100), track('a'), track('b'));

  assert.equal(session.current?.id, 'a');
  assert.deepEqual(
    session.upcoming.map((t) => t.id),
    ['b'],
  );
});

test('enqueue next jumps the queue', () => {
  let session = play(emptySession(-100), track('a'), track('b'));
  session = reduce(session, { type: 'enqueue', track: track('c'), position: 'next' }).session;

  assert.deepEqual(
    session.upcoming.map((t) => t.id),
    ['c', 'b'],
  );
});

test('leaving on an exhausted queue clears the session', () => {
  let session = play(emptySession(-100), track('a'));
  const { session: after, effects } = reduce(session, { type: 'stream_ended' });

  assert.equal(after.phase.name, 'idle');
  assert.equal(after.current, null);
  assert.deepEqual(
    effects.map((e) => e.kind),
    ['leave'],
  );
  // History survives so /previous still works after the call drops.
  assert.deepEqual(
    after.history.map((t) => t.id),
    ['a'],
  );
});

test('loop track repeats on natural end but not on manual skip', () => {
  let session = play(emptySession(-100), track('a'), track('b'));
  session = reduce(session, { type: 'set_loop', mode: 'track' }).session;

  const ended = reduce(session, { type: 'stream_ended' });
  assert.equal(ended.session.current?.id, 'a', 'natural end should replay the track');

  const skipped = reduce(session, { type: 'skip' });
  assert.equal(skipped.session.current?.id, 'b', 'explicit skip should override track loop');
});

test('loop queue recycles the finished track to the back', () => {
  let session = play(emptySession(-100), track('a'), track('b'));
  session = reduce(session, { type: 'set_loop', mode: 'queue' }).session;
  session = reduce(session, { type: 'stream_ended' }).session;

  assert.equal(session.current?.id, 'b');
  assert.deepEqual(
    session.upcoming.map((t) => t.id),
    ['a'],
  );
});

test('pause then resume preserves elapsed position', () => {
  let session = play(emptySession(-100), track('a'));
  session = reduce(session, { type: 'pause', atMs: 5_000 }).session;
  assert.equal(session.phase.name, 'paused');

  session = reduce(session, { type: 'resume', atMs: 9_000 }).session;
  assert.equal(session.phase.name, 'playing');
  // Four seconds paused shifts the origin forward so elapsed stays at 5s.
  assert.equal(session.phase.name === 'playing' && session.phase.startedAtMs, 4_000);
});

test('resume is a no-op when not paused', () => {
  const session = play(emptySession(-100), track('a'));
  const { effects } = reduce(session, { type: 'resume', atMs: 1_000 });
  assert.deepEqual(effects, []);
});

test('double skip advances exactly two tracks', () => {
  let session = play(emptySession(-100), track('a'), track('b'), track('c'));
  session = reduce(session, { type: 'skip' }).session;
  session = reduce(session, { type: 'skip' }).session;

  assert.equal(session.current?.id, 'c');
});

test('stop preserves volume but discards the queue', () => {
  let session = play(emptySession(-100), track('a'), track('b'));
  session = reduce(session, { type: 'set_volume', volume: 140 }).session;
  session = reduce(session, { type: 'stop' }).session;

  assert.equal(session.volume, 140);
  assert.equal(session.current, null);
  assert.equal(session.upcoming.length, 0);
  assert.equal(session.phase.name, 'idle');
});

test('volume clamps to the sidecar range', () => {
  const session = play(emptySession(-100), track('a'));
  assert.equal(reduce(session, { type: 'set_volume', volume: 900 }).session.volume, 200);
  assert.equal(reduce(session, { type: 'set_volume', volume: -40 }).session.volume, 0);
});

test('shuffle is deterministic for a given seed and preserves membership', () => {
  const session = play(emptySession(-100), track('a'), track('b'), track('c'), track('d'), track('e'));

  const first = reduce(session, { type: 'shuffle', seed: 42 }).session.upcoming.map((t) => t.id);
  const again = reduce(session, { type: 'shuffle', seed: 42 }).session.upcoming.map((t) => t.id);

  assert.deepEqual(first, again);
  assert.deepEqual([...first].sort(), ['b', 'c', 'd', 'e']);
});

test('remaining time is unknown when a live stream is queued', () => {
  const session = play(emptySession(-100), track('a'), track('b', { isLive: true, durationSec: 0 }));
  assert.equal(remainingSeconds(session), null);
});

test('remaining time sums current and upcoming', () => {
  const session = play(emptySession(-100), track('a'), track('b'));
  assert.equal(remainingSeconds(session), 360);
});

test('call_empty tears the session down like a stop', () => {
  const session = play(emptySession(-100), track('a'), track('b'));
  const { session: after, effects } = reduce(session, { type: 'call_empty' });

  assert.equal(after.phase.name, 'idle');
  assert.deepEqual(
    effects.map((e) => e.kind),
    ['leave'],
  );
});
