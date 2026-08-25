// Telegram rejects messages over 4096 characters, so every outbound message is
// truncated defensively. Cutting at a fixed index can land BETWEEN the two code
// units of an astral character (the 👤 / 📄 / 👨‍💼 emoji these messages are built
// from are all astral), leaving a lone surrogate that encodes to a replacement
// character on the wire.
//
// Extracted from the /api/session-end handler so every Telegram sender shares
// one implementation — the /api/cron/silent-links messages had the same fixed
// cut and the same emoji, and were silently corrupting on long runs.

export const TELEGRAM_SAFE_LIMIT = 3900;

export function truncateForTelegram(text: string, limit: number = TELEGRAM_SAFE_LIMIT): string {
  if (typeof text !== "string") return "";
  if (text.length <= limit) return text;

  // Back off one code unit if the cut would split a surrogate pair.
  let cut = limit;
  const code = text.charCodeAt(cut - 1);
  if (code >= 0xd800 && code <= 0xdbff) cut -= 1;

  return text.slice(0, cut) + "…";
}
