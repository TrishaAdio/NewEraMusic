# NewEra

Telegram group-call music bot. TypeScript control plane, Go audio sidecar,
targeting Bot API 10.3.

This is a clean-room implementation, not a fork. The feature set was informed by
studying the existing Python bots in this space — see [Prior art](#prior-art).
No code was carried over; the language, architecture, data model, and UI layer
are all new.

## Why the split

Telegram group calls run on [ntgcalls](https://github.com/pytgcalls/ntgcalls), a
C++/WebRTC engine. It ships bindings for **Python, Go, C and Java — explicitly
not Node**. From its own README: "We removed anything that could burden the
library, including NodeJS." The historical JavaScript options are dead:

| Package | Latest | Last published |
|---|---|---|
| `tgcalls` | 1.0.1 | 2021-09-08 |
| `gram-tgcalls` | 2.1.9 | 2021-12-03 |

Both predate the current group-call protocol and will not connect.

So the WebRTC boundary lives in a small Go binary and nothing else does. It holds
call connections and moves bytes — it has no concept of a queue, track, user,
permission, or command. Everything interesting is TypeScript.

```
┌──────────────────────── TypeScript ────────────────────────┐
│  apps/bot            grammY, command routing               │
│  packages/ui         rich messages, ephemeral, views       │
│  packages/queue      queue state machine (pure)            │
│  packages/core       config, logging                       │
└───────────────────────────┬────────────────────────────────┘
                            │ gRPC  (proto/voice.proto)
┌───────────────────────────▼────────────────────────────────┐
│  apps/voice          Go + ntgcalls. Join, leave, feed PCM. │
└────────────────────────────────────────────────────────────┘
```

The contract between them is one file: [`proto/voice.proto`](proto/voice.proto).
Queue advancement is driven by a single event, `STREAM_ENDED`.

## What's different

**Ephemeral by default.** Bot API 10.2 added messages visible to one user only.
Every pre-2026 music bot posts all replies publicly, so an active group collects
hundreds of "queue list" and "you are not an admin" messages. Here that is
inverted:

| Public | Ephemeral |
|---|---|
| now playing, session ended | panels, queue, settings, every error and denial |

**Real tables.** The queue renders as a `RichBlockTable` (Bot API 10.1), so
columns align on the client instead of via padded monospace. Past ten rows it
collapses into a `RichBlockExpandableBlockQuotation`.

**Disabled buttons, not error toasts.** `DisabledButton` (Bot API 10.3) greys
out `skip` when nothing is queued, rather than accepting the press and replying
with a failure.

**The queue is a pure state machine.** `(state, event) => { state, effects }`,
with no I/O. This is what makes the classic bugs in this bot family
unrepresentable: double-skip advancing two tracks, a stale `/end` killing a
session that already restarted, loop mode surviving a stop. 15 tests, no mocks,
no fake bot.

## Style is enforced, not documented

House rules live in [`.kiro/steering/house-style.md`](.kiro/steering/house-style.md)
and are checked by `pnpm test:style`, which fails the build on:

- any emoji outside a two-entry allowlist
- italic markup of any kind
- Unicode small-caps and other font-faking

That last one is not cosmetic. Small-caps text (`ᴇxᴀᴍᴘʟᴇ`) breaks screen readers,
breaks search, and tokenises at roughly three tokens per character.

The visual vocabulary is a single file, [`packages/ui/src/symbols.ts`](packages/ui/src/symbols.ts).
Every glyph has exactly one meaning.

## Development

Requires Node 22+, Go 1.24+, pnpm 10+, ffmpeg, and PostgreSQL + Redis.

```bash
pnpm install
pnpm build
pnpm check          # typecheck + tests + style
pnpm preview        # render every view to the terminal
```

`pnpm preview` renders all UI surfaces without a bot token or a live call —
useful for reviewing copy and layout before deploying.

Streaming into a group call requires a user account, not a bot account. That is
a Telegram protocol constraint. Generate a session string with `pnpm session`
and keep it out of version control; it grants full account access.

## Prior art

The command surface and platform coverage were derived by reading these
projects. They are GPL-3.0 and MIT respectively; no code from either is present
here, and this notice is courtesy rather than obligation.

- [TeamYukki/YukkiMusicBot](https://github.com/TeamYukki/YukkiMusicBot)
- [AnonymousX1025/AnonXMusic](https://github.com/AnonymousX1025/AnonXMusic)

## License

MIT. See [LICENSE](LICENSE).
