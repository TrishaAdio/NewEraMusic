/**
 * The complete visual vocabulary of the bot. Nothing outside this file may
 * introduce a glyph or emoji into user-facing output.
 *
 * Rationale: consistency is the whole difference between a bot that looks built
 * and one that looks assembled. Centralising the vocabulary means restyling is
 * one commit, and `test:style` can mechanically prove no stray emoji crept in.
 */

/**
 * Typographic glyphs. These carry structure and state. They are not decoration,
 * so every entry below has exactly one meaning and is used only for that.
 */
export const GLYPH = {
  /** Leads the currently active item in any list. */
  active: '\u25B8', // ▸
  /** Leads a pending / inactive item. */
  item: '\u25AA', // ▪
  /** Separates inline metadata: `3:42 ∙ opus ∙ 128k` */
  dot: '\u2219', // ∙
  /** Vertical rule inside table cells and headers. */
  pipe: '\u2502', // │
  /** Horizontal rule. Repeat, never pad with spaces. */
  rule: '\u2500', // ─
  /** Section marker in headings. */
  section: '\u25C8', // ◈
  /** Marks a value the user changed this interaction. */
  changed: '\u27E1', // ⟡
  /** Failure. Never a red cross emoji. */
  fail: '\u2715', // ✕

  playing: '\u23F5', // ⏵
  paused: '\u23F8', // ⏸
  stopped: '\u23F9', // ⏹
  next: '\u23ED', // ⏭
  shuffle: '\u21C4', // ⇄
  loop: '\u21BB', // ↻
} as const;

/**
 * The emoji allowlist. Deliberately tiny and deliberately uncommon — the point
 * is that seeing one means something, which stops being true past about three.
 *
 * At most one MARK per message. If a message needs two, it needs to be two
 * messages or none.
 */
export const MARK = {
  /** Session opened — the bot joined a call. Used once per session. */
  session: '\u{1FA90}', // 🪐
  /** A destructive or irreversible admin action completed. */
  gavel: '\u2696\uFE0F', // ⚖️
} as const;

export type Glyph = (typeof GLYPH)[keyof typeof GLYPH];
export type Mark = (typeof MARK)[keyof typeof MARK];

const ALLOWED = new Set<string>([...Object.values(GLYPH), ...Object.values(MARK)]);

/**
 * Matches emoji presentation characters and pictographs. Used by the style test
 * to reject anything not in ALLOWED. Kept here so the allowlist and the detector
 * cannot drift apart.
 */
export const EMOJI_PATTERN =
  /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{1F1E6}-\u{1F1FF}]/gu;

/** Font-faking ranges: Unicode small caps and mathematical alphanumerics. */
export const FAKE_FONT_PATTERN = /[\u1D00-\u1D7F\u{1D400}-\u{1D7FF}]/gu;

export function isAllowedSymbol(s: string): boolean {
  return ALLOWED.has(s);
}

/**
 * Repeats {@link GLYPH.rule} to build a divider. Prefer a real
 * `RichBlockDivider` in rich messages; this exists for plain-HTML fallbacks.
 */
export function rule(width = 24): string {
  return GLYPH.rule.repeat(width);
}

/** Joins metadata fragments with the separator dot, dropping empty values. */
export function meta(...parts: Array<string | number | null | undefined>): string {
  return parts
    .filter((p): p is string | number => p !== null && p !== undefined && p !== '')
    .join(` ${GLYPH.dot} `);
}

/** `3:42`, `1:02:15`. Telegram has no duration entity, so we format ourselves. */
export function duration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const seconds = s % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

/**
 * A proportional progress bar built from block-drawing characters. Reads as a
 * bar at any width and contains no emoji.
 */
export function progress(positionMs: number, totalMs: number, width = 18): string {
  if (totalMs <= 0) return '\u2591'.repeat(width);
  const ratio = Math.min(1, Math.max(0, positionMs / totalMs));
  const filled = Math.round(ratio * width);
  return '\u2588'.repeat(filled) + '\u2591'.repeat(width - filled);
}
