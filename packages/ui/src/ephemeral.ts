/**
 * Ephemeral messaging (Bot API 10.2, extended in 10.3).
 *
 * This is the single biggest behavioural difference between NewEra and every
 * pre-2026 Telegram music bot. Older bots post every reply publicly, so an
 * active group accumulates hundreds of "queue list", "you are not an admin",
 * and "paused" messages that nobody wants and someone has to purge.
 *
 * Here the default is inverted. A reply is ephemeral — visible only to the user
 * who triggered it — unless it is genuinely group-relevant news. In practice:
 *
 *   public     now playing, track added by someone else, session ended
 *   ephemeral  control panels, queue listings, settings, every error,
 *              every permission denial, every confirmation
 *
 * The group sees a handful of messages per session instead of hundreds.
 */

import type { InputRichMessage } from './rich.js';

export interface EphemeralMessageParameters {
  /** The only user who will see this message. */
  receiver_user_id: number;
  /**
   * Present when the message answers a button press. Required by Telegram to
   * bind the ephemeral message to that interaction.
   */
  callback_query_id?: string;
  /**
   * Bot API 10.3. Renders the ephemeral message in place of the message whose
   * button was pressed, for this user only. This is how a control panel updates
   * per-user without mutating shared group state — two admins can each hold a
   * different panel view on the same underlying message.
   */
  replace_callback_query_message?: boolean;
}

/** How a reply should be delivered. */
export type Visibility =
  | { kind: 'public' }
  | {
      kind: 'ephemeral';
      userId: number;
      // Explicit `| undefined` because the workspace runs with
      // exactOptionalPropertyTypes, which distinguishes "absent" from
      // "present and undefined". Builders below pass through undefined.
      callbackQueryId?: string | undefined;
      replaceOrigin?: boolean | undefined;
    };

export const publicly = (): Visibility => ({ kind: 'public' });

export const onlyFor = (
  userId: number,
  opts: { callbackQueryId?: string | undefined; replaceOrigin?: boolean | undefined } = {},
): Visibility => ({
  kind: 'ephemeral',
  userId,
  callbackQueryId: opts.callbackQueryId,
  replaceOrigin: opts.replaceOrigin,
});

export function toApiParams(v: Visibility): EphemeralMessageParameters | undefined {
  if (v.kind === 'public') return undefined;
  return {
    receiver_user_id: v.userId,
    ...(v.callbackQueryId ? { callback_query_id: v.callbackQueryId } : {}),
    ...(v.replaceOrigin ? { replace_callback_query_message: true } : {}),
  };
}

// ---------------------------------------------------------------------------
// Reply markup — Bot API 9.4 button styling and 10.3 disabled buttons
// ---------------------------------------------------------------------------

export type ButtonStyle = 'default' | 'primary' | 'destructive';

export interface Button {
  text: string;
  data: string;
  /**
   * Bot API 10.3. A disabled button renders greyed and cannot be pressed. This
   * replaces the old pattern of accepting the press and answering with an
   * error toast: if the queue is empty, "next" is visibly unavailable rather
   * than a trap.
   */
  disabled?: boolean;
  /** Bot API 9.4 button tinting. */
  style?: ButtonStyle;
  /** Bot API 9.4. Requires the bot owner to hold Telegram Premium. */
  iconCustomEmojiId?: string;
}

export interface InlineKeyboard {
  inline_keyboard: Array<
    Array<
      | { text: string; callback_data: string; style?: ButtonStyle; icon_custom_emoji_id?: string }
      | { text: string; disabled: true }
    >
  >;
  /** Bot API 10.3. */
  force_reply?: boolean;
}

/**
 * Builds inline keyboard JSON, collapsing disabled buttons to `DisabledButton`.
 * Rows that end up empty are dropped so callers can emit conditional buttons
 * without guarding every one.
 */
export function keyboard(rows: (Button | null | false | undefined)[][]): InlineKeyboard {
  const inline_keyboard = rows
    .map((row) =>
      row
        .filter((btn): btn is Button => Boolean(btn))
        .map((btn) =>
          btn.disabled
            ? ({ text: btn.text, disabled: true } as const)
            : ({
                text: btn.text,
                callback_data: btn.data,
                ...(btn.style && btn.style !== 'default' ? { style: btn.style } : {}),
                ...(btn.iconCustomEmojiId
                  ? { icon_custom_emoji_id: btn.iconCustomEmojiId }
                  : {}),
              } as const),
        ),
    )
    .filter((row) => row.length > 0);

  return { inline_keyboard };
}

// ---------------------------------------------------------------------------
// Outgoing reply
// ---------------------------------------------------------------------------

/**
 * A fully described reply. Handlers return this instead of calling the Telegram
 * API directly, which keeps them synchronous and pure — a handler is a function
 * from state to a Reply, so it can be asserted on in tests without a network
 * stub or a fake bot.
 */
export interface Reply {
  visibility: Visibility;
  message: InputRichMessage;
  markup?: InlineKeyboard | undefined;
  /** Suppresses the link preview for track URLs in now-playing announcements. */
  disableLinkPreview?: boolean | undefined;
}

export function reply(
  visibility: Visibility,
  message: InputRichMessage,
  opts: { markup?: InlineKeyboard | undefined; disableLinkPreview?: boolean | undefined } = {},
): Reply {
  return { visibility, message, ...opts };
}
