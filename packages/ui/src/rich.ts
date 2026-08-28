/**
 * Builders for Bot API 10.1+ rich messages.
 *
 * Rich messages replace hand-aligned monospace text with real structure:
 * tables that align on the client, collapsible blocks, dividers. A queue of 40
 * tracks becomes one expandable table instead of a wall of numbered lines.
 *
 * The API does expose an italic rich-text type. It is intentionally not
 * re-exported here — see .kiro/steering/house-style.md. (style-ok)
 */

export type RichText =
  | { type: 'plain'; text: string }
  | { type: 'bold'; text: RichText[] }
  | { type: 'code'; text: string }
  | { type: 'underline'; text: RichText[] }
  | { type: 'strikethrough'; text: RichText[] }
  | { type: 'spoiler'; text: RichText[] }
  | { type: 'url'; text: RichText[]; url: string }
  | { type: 'date_time'; date: number }
  | { type: 'text_mention'; text: RichText[]; user_id: number }
  | { type: 'custom_emoji'; custom_emoji_id: string };

export type RichBlock =
  | { type: 'paragraph'; text: RichText[] }
  | { type: 'section_heading'; text: RichText[] }
  | { type: 'divider' }
  | { type: 'footer'; text: RichText[] }
  | { type: 'preformatted'; text: RichText[]; language?: string | undefined }
  | { type: 'block_quotation'; text: RichText[] }
  | { type: 'expandable_block_quotation'; text: RichText[] }
  | { type: 'list'; items: RichBlockListItem[]; is_ordered?: boolean | undefined }
  | { type: 'table'; rows: RichBlockTableRow[]; is_compact?: boolean | undefined }
  | { type: 'details'; header: RichText[]; blocks: RichBlock[] }
  | { type: 'audio'; media: string; caption?: RichText[] | undefined }
  | { type: 'photo'; media: string; caption?: RichText[] | undefined };

export interface RichBlockListItem {
  blocks: RichBlock[];
}

export interface RichBlockTableCell {
  text: RichText[];
  is_header?: boolean | undefined;
}

export interface RichBlockTableRow {
  cells: RichBlockTableCell[];
}

export interface InputRichMessage {
  blocks: RichBlock[];
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

export const t = (text: string): RichText => ({ type: 'plain', text });
export const b = (...text: (RichText | string)[]): RichText => ({
  type: 'bold',
  text: lift(text),
});
export const code = (text: string): RichText => ({ type: 'code', text });
export const strike = (...text: (RichText | string)[]): RichText => ({
  type: 'strikethrough',
  text: lift(text),
});
export const spoiler = (...text: (RichText | string)[]): RichText => ({
  type: 'spoiler',
  text: lift(text),
});
export const link = (url: string, ...text: (RichText | string)[]): RichText => ({
  type: 'url',
  text: lift(text),
  url,
});
export const mention = (userId: number, ...text: (RichText | string)[]): RichText => ({
  type: 'text_mention',
  text: lift(text),
  user_id: userId,
});

/**
 * Renders a client-localised absolute date. Bot API 9.5 added this entity so
 * bots stop shipping UTC strings to users in other timezones.
 */
export const dateTime = (when: Date | number): RichText => ({
  type: 'date_time',
  date: Math.floor((when instanceof Date ? when.getTime() : when) / 1000),
});

function lift(parts: (RichText | string)[]): RichText[] {
  return parts.map((p) => (typeof p === 'string' ? t(p) : p));
}

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

export const para = (...text: (RichText | string)[]): RichBlock => ({
  type: 'paragraph',
  text: lift(text),
});
export const heading = (...text: (RichText | string)[]): RichBlock => ({
  type: 'section_heading',
  text: lift(text),
});
export const divider = (): RichBlock => ({ type: 'divider' });
export const footer = (...text: (RichText | string)[]): RichBlock => ({
  type: 'footer',
  text: lift(text),
});
export const quote = (...text: (RichText | string)[]): RichBlock => ({
  type: 'block_quotation',
  text: lift(text),
});

/**
 * Collapsed by default. This is what makes a 40-track queue readable — the
 * first rows show, the rest expand on tap, and the group chat is not flooded.
 */
export const expandable = (...text: (RichText | string)[]): RichBlock => ({
  type: 'expandable_block_quotation',
  text: lift(text),
});

export const list = (
  items: (RichBlock[] | RichBlock)[],
  opts: { ordered?: boolean } = {},
): RichBlock => ({
  type: 'list',
  is_ordered: opts.ordered,
  items: items.map((i) => ({ blocks: Array.isArray(i) ? i : [i] })),
});

export const details = (header: (RichText | string)[], blocks: RichBlock[]): RichBlock => ({
  type: 'details',
  header: lift(header),
  blocks,
});

/**
 * Builds a table from a header row plus body rows. Cells accept raw strings for
 * the common case. `compact` (Bot API 10.3) tightens padding, which is what you
 * want for dense queue listings.
 */
export function table(
  header: (RichText | string)[] | null,
  rows: (RichText | string)[][],
  opts: { compact?: boolean } = {},
): RichBlock {
  const out: RichBlockTableRow[] = [];
  if (header) {
    out.push({ cells: header.map((c) => ({ text: lift([c]), is_header: true })) });
  }
  for (const row of rows) {
    out.push({ cells: row.map((c) => ({ text: lift([c]) })) });
  }
  return { type: 'table', rows: out, is_compact: opts.compact };
}

export function rich(...blocks: (RichBlock | RichBlock[] | null | undefined)[]): InputRichMessage {
  return {
    blocks: blocks
      .flat()
      .filter((x): x is RichBlock => x !== null && x !== undefined),
  };
}
