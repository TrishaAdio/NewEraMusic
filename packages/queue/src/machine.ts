/**
 * The queue as a pure state machine.
 *
 * Every transition is `(state, event) => state`. There is no I/O, no Telegram,
 * no gRPC, and no clock in this file, which is why the whole thing is testable
 * with plain assertions and why concurrent commands cannot corrupt it.
 *
 * The reference implementations of this bot family keep playback state in
 * module-level dictionaries mutated from async handlers. That is the source of
 * their classic bugs: double-skip advancing two tracks, a stale `/end` killing
 * a session that already restarted, loop mode surviving a stop. Modelling the
 * session explicitly makes those states unrepresentable.
 */

export interface Track {
  id: string;
  title: string;
  /** Seconds. Zero means unknown (live streams). */
  durationSec: number;
  uri: string;
  webUrl?: string;
  thumbnailUrl?: string;
  source: 'youtube' | 'spotify' | 'soundcloud' | 'apple' | 'telegram' | 'direct';
  requestedBy: { id: number; name: string };
  /** Live streams cannot be seeked and never end on their own. */
  isLive: boolean;
}

export type LoopMode = 'off' | 'track' | 'queue';

export type Phase =
  | { name: 'idle' }
  | { name: 'joining' }
  | { name: 'playing'; startedAtMs: number; pausedAtMs: null }
  | { name: 'paused'; startedAtMs: number; pausedAtMs: number }
  | { name: 'leaving' };

export interface Session {
  chatId: number;
  phase: Phase;
  current: Track | null;
  upcoming: Track[];
  /** Tracks already played this session, newest first. Powers `/previous`. */
  history: Track[];
  loop: LoopMode;
  volume: number;
  /** Monotonic counter. Guards against stale commands; see `Command.epoch`. */
  epoch: number;
}

export function emptySession(chatId: number): Session {
  return {
    chatId,
    phase: { name: 'idle' },
    current: null,
    upcoming: [],
    history: [],
    loop: 'off',
    volume: 100,
    epoch: 0,
  };
}

export type Event =
  | { type: 'enqueue'; track: Track; position?: 'end' | 'next' }
  | { type: 'joined' }
  | { type: 'skip' }
  | { type: 'previous' }
  | { type: 'pause'; atMs: number }
  | { type: 'resume'; atMs: number }
  | { type: 'stop' }
  | { type: 'stream_ended' }
  | { type: 'set_loop'; mode: LoopMode }
  | { type: 'set_volume'; volume: number }
  | { type: 'shuffle'; seed: number }
  | { type: 'remove'; trackId: string }
  | { type: 'clear' }
  | { type: 'call_empty' };

/**
 * Side effects the machine wants performed. The machine never performs them;
 * the caller applies them against the sidecar. This keeps the reducer pure and
 * makes the effect sequence assertable.
 */
export type Effect =
  | { kind: 'join'; chatId: number; track: Track }
  | { kind: 'play'; chatId: number; track: Track }
  | { kind: 'pause'; chatId: number }
  | { kind: 'resume'; chatId: number }
  | { kind: 'leave'; chatId: number }
  | { kind: 'volume'; chatId: number; volume: number }
  | { kind: 'announce_now_playing'; chatId: number; track: Track };

export interface Transition {
  session: Session;
  effects: Effect[];
}

const nothing = (session: Session): Transition => ({ session, effects: [] });

export function reduce(session: Session, event: Event): Transition {
  switch (event.type) {
    case 'enqueue': {
      // First track in an idle session starts a call rather than queuing.
      if (session.phase.name === 'idle' && session.current === null) {
        return {
          session: {
            ...session,
            phase: { name: 'joining' },
            current: event.track,
            epoch: session.epoch + 1,
          },
          effects: [{ kind: 'join', chatId: session.chatId, track: event.track }],
        };
      }
      const upcoming =
        event.position === 'next'
          ? [event.track, ...session.upcoming]
          : [...session.upcoming, event.track];
      return nothing({ ...session, upcoming });
    }

    case 'joined': {
      if (session.phase.name !== 'joining' || !session.current) return nothing(session);
      return {
        session: { ...session, phase: { name: 'playing', startedAtMs: 0, pausedAtMs: null } },
        effects: [
          { kind: 'announce_now_playing', chatId: session.chatId, track: session.current },
        ],
      };
    }

    // A manual skip ignores `loop: 'track'` — the user asked for the next
    // track, not a replay. Only `stream_ended` honours track looping.
    case 'skip':
      return advance(session, { honourTrackLoop: false });

    case 'stream_ended':
      return advance(session, { honourTrackLoop: true });

    case 'previous': {
      const [prev, ...rest] = session.history;
      if (!prev) return nothing(session);
      const upcoming = session.current ? [session.current, ...session.upcoming] : session.upcoming;
      return {
        session: { ...session, current: prev, history: rest, upcoming },
        effects: [
          { kind: 'play', chatId: session.chatId, track: prev },
          { kind: 'announce_now_playing', chatId: session.chatId, track: prev },
        ],
      };
    }

    case 'pause': {
      if (session.phase.name !== 'playing') return nothing(session);
      return {
        session: {
          ...session,
          phase: {
            name: 'paused',
            startedAtMs: session.phase.startedAtMs,
            pausedAtMs: event.atMs,
          },
        },
        effects: [{ kind: 'pause', chatId: session.chatId }],
      };
    }

    case 'resume': {
      if (session.phase.name !== 'paused') return nothing(session);
      // Shift the start time forward by the pause duration so elapsed position
      // stays correct without the machine reading a clock.
      const pausedFor = event.atMs - session.phase.pausedAtMs;
      return {
        session: {
          ...session,
          phase: {
            name: 'playing',
            startedAtMs: session.phase.startedAtMs + pausedFor,
            pausedAtMs: null,
          },
        },
        effects: [{ kind: 'resume', chatId: session.chatId }],
      };
    }

    case 'stop':
    case 'call_empty': {
      if (session.phase.name === 'idle') return nothing(session);
      return {
        session: {
          ...emptySession(session.chatId),
          // Preserve operator-set preferences across a stop; they are chat
          // configuration, not session state.
          volume: session.volume,
          epoch: session.epoch + 1,
        },
        effects: [{ kind: 'leave', chatId: session.chatId }],
      };
    }

    case 'set_loop':
      return nothing({ ...session, loop: event.mode });

    case 'set_volume': {
      const volume = Math.min(200, Math.max(0, Math.round(event.volume)));
      return {
        session: { ...session, volume },
        effects: [{ kind: 'volume', chatId: session.chatId, volume }],
      };
    }

    case 'shuffle': {
      return nothing({ ...session, upcoming: shuffle(session.upcoming, event.seed) });
    }

    case 'remove': {
      return nothing({
        ...session,
        upcoming: session.upcoming.filter((t) => t.id !== event.trackId),
      });
    }

    case 'clear':
      return nothing({ ...session, upcoming: [] });
  }
}

function advance(session: Session, opts: { honourTrackLoop: boolean }): Transition {
  const { current } = session;
  if (!current) return nothing(session);

  if (opts.honourTrackLoop && session.loop === 'track') {
    return {
      session,
      effects: [{ kind: 'play', chatId: session.chatId, track: current }],
    };
  }

  const history = [current, ...session.history].slice(0, 50);
  let upcoming = session.upcoming;

  // Queue looping recycles the finished track to the back, so the rotation is
  // stable rather than depending on when the user enabled it.
  if (session.loop === 'queue') {
    upcoming = [...upcoming, current];
  }

  const [next, ...rest] = upcoming;

  if (!next) {
    return {
      session: {
        ...emptySession(session.chatId),
        history,
        loop: session.loop,
        volume: session.volume,
        epoch: session.epoch + 1,
      },
      effects: [{ kind: 'leave', chatId: session.chatId }],
    };
  }

  return {
    session: { ...session, current: next, upcoming: rest, history },
    effects: [
      { kind: 'play', chatId: session.chatId, track: next },
      { kind: 'announce_now_playing', chatId: session.chatId, track: next },
    ],
  };
}

/**
 * Seeded Fisher-Yates. Seeded rather than `Math.random` so a shuffle is
 * reproducible in tests and can be replayed from an event log.
 */
function shuffle<T>(items: readonly T[], seed: number): T[] {
  const out = [...items];
  let state = seed >>> 0 || 1;
  for (let i = out.length - 1; i > 0; i--) {
    // xorshift32
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    const j = state % (i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** Total remaining seconds, or null when any track is a live stream. */
export function remainingSeconds(session: Session): number | null {
  const tracks = [session.current, ...session.upcoming].filter((t): t is Track => t !== null);
  if (tracks.some((t) => t.isLive)) return null;
  return tracks.reduce((sum, t) => sum + t.durationSec, 0);
}
