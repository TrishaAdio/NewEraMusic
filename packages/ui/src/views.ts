/**
 * Every user-facing surface in the bot. Views are pure functions from state to
 * a {@link Reply}: no API calls, no awaits. That makes them snapshot-testable
 * and keeps all copy in one reviewable place.
 */

import type { Session, Track } from '@newera/queue';
import { remainingSeconds } from '@newera/queue';
import { GLYPH, MARK, duration, meta, progress } from './symbols.js';
import {
  b,
  code,
  divider,
  expandable,
  footer,
  heading,
  link,
  mention,
  para,
  quote,
  rich,
  t,
  table,
  type RichBlock,
} from './rich.js';
import { keyboard, onlyFor, publicly, reply, type Reply } from './ephemeral.js';

const MAX_TITLE = 44;

function clip(title: string, max = MAX_TITLE): string {
  const trimmed = title.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1).trimEnd()}\u2026`;
}

function trackTitle(track: Track) {
  const label = clip(track.title);
  return track.webUrl ? link(track.webUrl, label) : t(label);
}

function lengthOf(track: Track): string {
  return track.isLive ? 'live' : duration(track.durationSec);
}

// ---------------------------------------------------------------------------
// Now playing — the one surface that is public
// ---------------------------------------------------------------------------

/**
 * Posted publicly, because a track change is genuinely group-relevant. Every
 * other surface below is ephemeral.
 */
export function nowPlaying(session: Session, positionMs = 0): Reply {
  const track = session.current;
  if (!track) return idle(0);

  const totalMs = track.durationSec * 1000;
  const state = session.phase.name === 'paused' ? GLYPH.paused : GLYPH.playing;

  const bar: RichBlock[] = track.isLive
    ? [para(code('live'), t(` ${GLYPH.dot} no fixed duration`))]
    : [
        para(
          code(progress(positionMs, totalMs)),
          t(`  ${duration(positionMs / 1000)} / ${duration(track.durationSec)}`),
        ),
      ];

  return reply(
    publicly(),
    rich(
      heading(t(`${state} `), b(trackTitle(track))),
      para(t(meta(track.source, lengthOf(track)) + ` ${GLYPH.dot} `), mention(track.requestedBy.id, track.requestedBy.name)),
      ...bar,
      session.upcoming.length > 0
        ? quote(t(`${GLYPH.next} next `), b(clip(session.upcoming[0]!.title, 32)))
        : null,
    ),
    { markup: controls(session), disableLinkPreview: true },
  );
}

/** Playback controls. Buttons that cannot act are disabled, never silently dead. */
function controls(session: Session) {
  const playing = session.phase.name === 'playing';
  const active = playing || session.phase.name === 'paused';
  const hasNext = session.upcoming.length > 0 || session.loop !== 'off';

  return keyboard([
    [
      {
        text: playing ? GLYPH.paused : GLYPH.playing,
        data: playing ? 'pause' : 'resume',
        disabled: !active,
      },
      { text: GLYPH.next, data: 'skip', disabled: !hasNext },
      { text: GLYPH.stopped, data: 'stop', style: 'destructive', disabled: !active },
    ],
    [
      { text: `${GLYPH.shuffle} shuffle`, data: 'shuffle', disabled: session.upcoming.length < 2 },
      {
        text: `${GLYPH.loop} ${session.loop}`,
        data: 'loop:cycle',
        style: session.loop === 'off' ? 'default' : 'primary',
      },
    ],
    [{ text: 'queue', data: 'queue:open' }, { text: 'settings', data: 'settings:open' }],
  ]);
}

// ---------------------------------------------------------------------------
// Queue — ephemeral, and a real table
// ---------------------------------------------------------------------------

/**
 * Rendered as a `RichBlockTable` so columns align on the client instead of via
 * padded monospace, and collapsed into an expandable block past ten rows so a
 * long queue does not become a wall.
 */
export function queueView(session: Session, viewerId: number, callbackQueryId?: string): Reply {
  if (!session.current) {
    return reply(onlyFor(viewerId, { callbackQueryId }), rich(para(t('Nothing queued.'))));
  }

  const VISIBLE = 10;
  const shown = session.upcoming.slice(0, VISIBLE);
  const hidden = session.upcoming.slice(VISIBLE);

  const rows = [
    [t(GLYPH.active), b(clip(session.current.title, 38)), t(lengthOf(session.current))],
    ...shown.map((track, i) => [
      t(`${GLYPH.item} ${i + 1}`),
      trackTitle(track),
      t(lengthOf(track)),
    ]),
  ];

  const total = remainingSeconds(session);
  const summary = meta(
    `${session.upcoming.length + 1} tracks`,
    total === null ? 'includes a live stream' : `${duration(total)} remaining`,
    session.loop === 'off' ? null : `${GLYPH.loop} ${session.loop}`,
  );

  return reply(
    onlyFor(viewerId, { callbackQueryId, replaceOrigin: Boolean(callbackQueryId) }),
    rich(
      heading(t(`${GLYPH.section} Queue`)),
      table(null, rows, { compact: true }),
      hidden.length > 0
        ? expandable(
            t(
              hidden
                .map((track, i) => `${VISIBLE + i + 1}. ${clip(track.title, 38)}  ${lengthOf(track)}`)
                .join('\n'),
            ),
          )
        : null,
      divider(),
      footer(t(summary)),
    ),
    {
      markup: keyboard([
        [
          { text: GLYPH.next, data: 'skip', disabled: session.upcoming.length === 0 },
          {
            text: `${GLYPH.shuffle} shuffle`,
            data: 'shuffle',
            disabled: session.upcoming.length < 2,
          },
          {
            text: `${GLYPH.fail} clear`,
            data: 'queue:clear',
            style: 'destructive',
            disabled: session.upcoming.length === 0,
          },
        ],
        [{ text: 'back', data: 'panel:open' }],
      ]),
    },
  );
}

// ---------------------------------------------------------------------------
// Confirmations and failures — ephemeral, terse
// ---------------------------------------------------------------------------

export function queued(track: Track, position: number, viewerId: number): Reply {
  return reply(
    onlyFor(viewerId),
    rich(
      para(b(clip(track.title)), t(` ${GLYPH.dot} `), t(`position ${position}`)),
      para(t(meta(track.source, lengthOf(track)))),
    ),
  );
}

export function sessionStarted(chatTitle: string, viewerId: number): Reply {
  return reply(
    onlyFor(viewerId),
    rich(para(t(`${MARK.session} `), b('Session open'), t(` in ${chatTitle}`))),
  );
}

export function idle(viewerId: number): Reply {
  return reply(onlyFor(viewerId), rich(para(t('No active session.'))));
}

/**
 * All failures are ephemeral. A user mistyping a command should not leave a
 * permanent error in the group.
 */
export function failure(message: string, viewerId: number, callbackQueryId?: string): Reply {
  return reply(
    onlyFor(viewerId, { callbackQueryId }),
    rich(para(t(`${GLYPH.fail} `), t(message))),
  );
}

export function notPermitted(viewerId: number, callbackQueryId?: string): Reply {
  return failure('Admins only.', viewerId, callbackQueryId);
}
