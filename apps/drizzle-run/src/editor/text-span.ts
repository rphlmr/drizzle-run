/** The part of a text an edit replaces: offsets `start` to `end` of the old text become `text`. */
export interface ChangedSpan {
  start: number;
  end: number;
  text: string;
}

const CARRIAGE_RETURN = 13;
const LINE_FEED = 10;

/** Whether `offset` falls between a surrogate pair's halves or a `\r\n` line break's. */
function isInsideCharacter(text: string, offset: number): boolean {
  const before = text.charCodeAt(offset - 1);
  const after = text.charCodeAt(offset);

  return (
    (before >= 0xd8_00 && before <= 0xdb_ff && after >= 0xdc_00 && after <= 0xdf_ff) ||
    (before === CARRIAGE_RETURN && after === LINE_FEED)
  );
}

/**
 * Find the smallest span to replace in `current` so it reads `next`
 *
 * Keeps the common start and end of both texts, so one typed character is a span of at most one character. A span
 * edge never splits a surrogate pair or a `\r\n` line break. Returns null when the texts are equal.
 *
 * @example
 * findChangedSpan("const a = 1;", "const ab = 1;"); // { start: 7, end: 7, text: "b" }
 */
export function findChangedSpan(current: string, next: string): ChangedSpan | null {
  if (current === next) {
    return null;
  }

  const shortest = Math.min(current.length, next.length);
  let prefix = 0;

  while (prefix < shortest && current.charCodeAt(prefix) === next.charCodeAt(prefix)) {
    prefix += 1;
  }

  while (prefix > 0 && (isInsideCharacter(current, prefix) || isInsideCharacter(next, prefix))) {
    prefix -= 1;
  }

  let suffix = 0;

  while (
    suffix < shortest - prefix &&
    current.charCodeAt(current.length - 1 - suffix) === next.charCodeAt(next.length - 1 - suffix)
  ) {
    suffix += 1;
  }

  while (
    suffix > 0 &&
    (isInsideCharacter(current, current.length - suffix) || isInsideCharacter(next, next.length - suffix))
  ) {
    suffix -= 1;
  }

  return { start: prefix, end: current.length - suffix, text: next.slice(prefix, next.length - suffix) };
}
