# House style — NewEra

Applies to every user-facing string and all source in this repo.

## Typography

**Never use italic.** Not `<i>`, not `_underscores_`, not `RichTextItalic`, not
`InputRichBlockPullQuotation` styled as italic. Italic reads cheap.

Permitted emphasis, in order of preference:

| Need | Use |
|---|---|
| Plain statement | no markup |
| Emphasis | `<b>` / `RichTextBold` |
| Identifier, value, ID, duration | `<code>` / `RichTextCode` |
| Secondary / hint text | `<blockquote>` / `RichBlockBlockQuotation` |
| Long collapsible content | `RichBlockExpandableBlockQuotation` |

Never use Unicode small-caps or other font-faking (`ᴇxᴀᴍᴘʟᴇ`). It breaks screen
readers, breaks search, and costs ~3 tokens per character. Plain sentence case.

## Glyphs and emoji

Structure comes from typographic glyphs, not emoji. The full permitted set lives
in `packages/ui/src/symbols.ts` and is the single source of truth.

- Emoji are **rare and deliberate**. At most one per message, and only from the
  `MARK` allowlist. No 🔥 🎵 ✅ ❌ 🎶 💫 — overused, reads like spam.
- Prefer glyphs: `▸ ▪ ∙ │ ─ ◈ ⟡ ⏵ ⏸ ⏹ ⏭ ⇄ ↻ ✕`
- Never decorate. A glyph must carry meaning (state, hierarchy, separation).

`pnpm test:style` fails the build on any emoji outside the allowlist and on any
italic markup. Style is enforced, not remembered.

## Copy

Lean and factual. State current state and real data.

Do not write:
- how-to footers (`Use /skip to skip`, `Tune /volume`)
- enforcement meta (`admins exempt`, `removed on sight`)
- filler acknowledgement (`Got it!`, `Sure thing!`)

Show the data. Show the state. Stop.

## Bot API baseline

Target **Bot API 10.3** (2026-08-24). Two features are load-bearing:

- **Ephemeral messages** — every control surface (panel, queue, errors,
  settings, permission denials) is ephemeral by default. Group chats stay clean.
  Only now-playing announcements are public.
- **Rich messages** — queue and stats render as `RichBlockTable`, not
  hand-aligned text. Long queues use `RichBlockExpandableBlockQuotation`.

Use `DisabledButton` / `disabled: true` rather than letting a user press a
button that will error.
