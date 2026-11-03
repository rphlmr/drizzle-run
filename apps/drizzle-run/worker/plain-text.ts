/**
 * True when `text` holds a C0 control character or DEL, such as NUL
 *
 * D1's `length()` stops counting at NUL, so such text passes the JavaScript length checks and then fails a column
 * CHECK, which would answer a retryable 503 for input that can never be stored.
 */
export function hasControlCharacter(text: string): boolean {
  for (const char of text) {
    if (isControlCharacter(char)) {
      return true;
    }
  }

  return false;
}

/**
 * Get `text` on one line, without its C0 control characters and DEL
 *
 * A tab or a line break becomes a space, so "Users\tposts" reads "Users posts"; the other control characters go.
 */
export function removeControlCharacters(text: string): string {
  let kept = "";

  for (const char of text) {
    if (lineSpacingCharacters.has(char)) {
      kept += " ";
    } else if (!isControlCharacter(char)) {
      kept += char;
    }
  }

  return kept;
}

/** Get the first `maxLength` characters of `text`, counted as D1's `length()` counts them, so no emoji splits. */
export function truncateCharacters(text: string, maxLength: number): string {
  return Array.from(text).slice(0, maxLength).join("");
}

const lineSpacingCharacters = new Set(["\t", "\n", "\v", "\f", "\r"]);

function isControlCharacter(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;

  return code < 0x20 || code === 0x7f;
}
