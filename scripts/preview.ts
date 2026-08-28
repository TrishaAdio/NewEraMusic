/**
 * Renders every view to the terminal as a rough approximation of the Telegram
 * client, so copy and layout can be reviewed without deploying a bot.
 *
 * This is a design tool, not a test. It deliberately renders structure (tables,
 * dividers, collapsed blocks) rather than pretending to be pixel-accurate.
 */

// Imports the built output rather than src, so the preview exercises the same
// artifacts the bot loads. Run `pnpm build` first.
import { emptySession, reduce, type Session, type Track } from '../packages/queue/dist/index.js';
import {
  nowPlaying,
  queueView,
  queued,
  type Reply,
  type RichBlock,
  type RichText,
} from '../packages/ui/dist/index.js';

const DIM = '\u001b[2m';
const BOLD = '\u001b[1m';
const CYAN = '\u001b[36m';
const YELLOW = '\u001b[33m';
const RESET = '\u001b[0m';

function renderText(parts: RichText[]): string {
  return parts
    .map((p) => {
      switch (p.type) {
        case 'plain':
          return p.text;
        case 'bold':
          return `${BOLD}${renderText(p.text)}${RESET}`;
        case 'code':
          return `${CYAN}${p.text}${RESET}`;
        case 'url':
          return `${renderText(p.text)}`;
        case 'text_mention':
          return `${YELLOW}@${renderText(p.text)}${RESET}`;
        case 'strikethrough':
          return `~${renderText(p.text)}~`;
        case 'spoiler':
          return `[spoiler]`;
        case 'date_time':
          return new Date(p.date * 1000).toISOString();
        case 'underline':
          return renderText(p.text);
        case 'custom_emoji':
          return '';
      }
    })
    .join('');
}

function visibleWidth(s: string): number {
  return s.replace(/\u001b\[[0-9;]*m/g, '').length;
}

function renderBlock(block: RichBlock): string[] {
  switch (block.type) {
    case 'paragraph':
      return [renderText(block.text)];
    case 'section_heading':
      return [`${BOLD}${renderText(block.text)}${RESET}`];
    case 'divider':
      return [`${DIM}${'\u2500'.repeat(46)}${RESET}`];
    case 'footer':
      return [`${DIM}${renderText(block.text)}${RESET}`];
    case 'block_quotation':
      return renderText(block.text)
        .split('\n')
        .map((l) => `${DIM}\u2502${RESET} ${l}`);
    case 'expandable_block_quotation': {
      const lines = renderText(block.text).split('\n');
      return [
        `${DIM}\u2502 [expandable \u2014 ${lines.length} more, collapsed in client]${RESET}`,
        ...lines.slice(0, 2).map((l) => `${DIM}\u2502 ${l}${RESET}`),
        `${DIM}\u2502 \u2026${RESET}`,
      ];
    }
    case 'preformatted':
      return renderText(block.text)
        .split('\n')
        .map((l) => `${CYAN}  ${l}${RESET}`);
    case 'list':
      return block.items.flatMap((item, i) =>
        item.blocks.flatMap(renderBlock).map((l) => `  ${i + 1}. ${l}`),
      );
    case 'table': {
      const cells = block.rows.map((r) => r.cells.map((c) => renderText(c.text)));
      const widths: number[] = [];
      for (const row of cells) {
        row.forEach((c, i) => {
          widths[i] = Math.max(widths[i] ?? 0, visibleWidth(c));
        });
      }
      return cells.map((row) =>
        row
          .map((c, i) => c + ' '.repeat(Math.max(0, (widths[i] ?? 0) - visibleWidth(c))))
          .join(`  ${DIM}\u2502${RESET} `),
      );
    }
    case 'details':
      return [
        `${BOLD}\u25B8 ${renderText(block.header)}${RESET}`,
        ...block.blocks.flatMap(renderBlock).map((l) => `  ${l}`),
      ];
    case 'audio':
    case 'photo':
      return [`${DIM}[${block.type}]${RESET}`];
  }
}

function show(label: string, r: Reply): void {
  const tag =
    r.visibility.kind === 'public'
      ? `${YELLOW}PUBLIC${RESET} \u2014 everyone in the group`
      : `${CYAN}EPHEMERAL${RESET} \u2014 visible only to user ${r.visibility.userId}`;

  console.log(`\n${DIM}\u250C\u2500 ${label} ${'\u2500'.repeat(Math.max(0, 44 - label.length))}${RESET}`);
  console.log(`${DIM}\u2502${RESET} ${tag}`);
  console.log(`${DIM}\u251C${'\u2500'.repeat(50)}${RESET}`);
  for (const line of r.message.blocks.flatMap(renderBlock)) {
    console.log(`${DIM}\u2502${RESET} ${line}`);
  }
  if (r.markup) {
    console.log(`${DIM}\u2502${RESET}`);
    for (const row of r.markup.inline_keyboard) {
      const rendered = row
        .map((btn) =>
          'disabled' in btn
            ? `${DIM}[ ${btn.text} ]${RESET}`
            : btn.style === 'destructive'
              ? `\u001b[31m[ ${btn.text} ]${RESET}`
              : btn.style === 'primary'
                ? `\u001b[32m[ ${btn.text} ]${RESET}`
                : `[ ${btn.text} ]`,
        )
        .join(' ');
      console.log(`${DIM}\u2502${RESET} ${rendered}`);
    }
  }
  console.log(`${DIM}\u2514${'\u2500'.repeat(50)}${RESET}`);
}

// --- fixture -----------------------------------------------------------------

const titles = [
  'Radiohead - Weird Fishes / Arpeggi',
  'Burial - Archangel',
  'Aphex Twin - Avril 14th',
  'Portishead - Roads',
  'Boards of Canada - Dayvan Cowboy',
  'Four Tet - Baby',
  'Bicep - Glue',
  'Jamie xx - Gosh',
  'Floating Points - Silhouettes',
  'Caribou - Odessa',
  'Mount Kimbie - Made to Stray',
  'Jon Hopkins - Emerald Rush',
  'Nils Frahm - Says',
  'Moderat - A New Error',
];

const mk = (i: number): Track => ({
  id: `t${i}`,
  title: titles[i % titles.length]!,
  durationSec: 150 + ((i * 37) % 220),
  uri: `file:///tmp/t${i}.opus`,
  webUrl: `https://youtu.be/x${i}`,
  source: i % 3 === 0 ? 'spotify' : 'youtube',
  requestedBy: { id: 8675309, name: 'trisha' },
  isLive: false,
});

let session: Session = emptySession(-1001234567890);
for (let i = 0; i < 14; i++) {
  session = reduce(session, { type: 'enqueue', track: mk(i) }).session;
}
session = reduce(session, { type: 'joined' }).session;

console.log(`\n${BOLD}NewEra \u2014 view preview${RESET}`);
console.log(`${DIM}Bot API 10.3 surfaces. No italic, allowlisted glyphs only.${RESET}`);

show('now playing', nowPlaying(session, 74_000));
show('queue (14 tracks)', queueView(session, 8675309, 'cbq_9931'));
show('added a track', queued(mk(21), 15, 8675309));

const looped = reduce(session, { type: 'set_loop', mode: 'queue' }).session;
show('now playing, queue loop on', nowPlaying(looped, 74_000));

const paused = reduce(session, { type: 'pause', atMs: 74_000 }).session;
show('paused', nowPlaying(paused, 74_000));

// Single track: shuffle and next are unavailable, so those buttons render
// disabled rather than accepting a press that would error.
let single: Session = emptySession(-100);
single = reduce(single, { type: 'enqueue', track: mk(3) }).session;
single = reduce(single, { type: 'joined' }).session;
show('single track (buttons disabled)', nowPlaying(single, 12_000));

console.log();
