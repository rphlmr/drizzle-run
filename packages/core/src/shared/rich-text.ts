/**
 * The small text format of guide bodies: paragraphs split on blank lines, `code` in
 * backticks, **bold**, and [links](https://example.com). Renderers turn the parsed
 * inlines into text nodes, never into HTML.
 */

/** One run of text inside a paragraph. */
export type RichTextInline =
  | { kind: "text" | "code" | "bold"; text: string }
  | { kind: "link"; text: string; href: string };

/** One paragraph of inlines. */
export type RichTextParagraph = readonly RichTextInline[];

/** Parsed rich text: paragraphs in order. */
export type RichText = readonly RichTextParagraph[];

/** Thrown by `parseRichText` on an unclosed span or an unsafe link. */
export class RichTextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RichTextError";
  }
}

const LINK_PATTERN = /^\[([^\]\n]+)\]\(([^)\s]+)\)/;

/** True when `text` holds a space, or a control character such as a tab or newline. */
function hasControlOrSpace(text: string): boolean {
  // Every space and control character is one UTF-16 unit, so units are enough.
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);

    if (code <= 0x20 || code === 0x7f) {
      return true;
    }
  }

  return false;
}

/**
 * Check that a link target is allowed in a guide
 *
 * Accepts an absolute https URL or a host-relative path such as `/examples/joins`, and rejects protocol-relative
 * `//` paths, backslashes and control or space characters: browsers drop tabs and newlines from a URL, so "/\t/evil"
 * would become "//evil" and leave the site. The host decides where relative paths lead.
 */
export function isGuideHref(href: string): boolean {
  if (href.startsWith("/")) {
    return !href.startsWith("//") && !href.includes("\\") && !hasControlOrSpace(href);
  }

  try {
    return new URL(href).protocol === "https:";
  } catch {
    return false;
  }
}

function parseParagraph(paragraph: string): RichTextParagraph {
  const inlines: RichTextInline[] = [];
  let text = "";
  let index = 0;

  const flushText = () => {
    if (text !== "") {
      inlines.push({ kind: "text", text });
      text = "";
    }
  };

  while (index < paragraph.length) {
    const rest = paragraph.slice(index);

    if (rest.startsWith("`")) {
      const end = paragraph.indexOf("`", index + 1);

      if (end === -1) {
        throw new RichTextError("A `code` span is not closed.");
      }

      flushText();

      if (end > index + 1) {
        inlines.push({ kind: "code", text: paragraph.slice(index + 1, end) });
      }

      index = end + 1;
      continue;
    }

    if (rest.startsWith("**")) {
      const end = paragraph.indexOf("**", index + 2);

      if (end === -1) {
        throw new RichTextError("A **bold** span is not closed.");
      }

      const bold = paragraph.slice(index + 2, end);

      if (bold.includes("`")) {
        throw new RichTextError("Bold text cannot contain `code`.");
      }

      flushText();

      if (bold !== "") {
        inlines.push({ kind: "bold", text: bold });
      }

      index = end + 2;
      continue;
    }

    const linkMatch = rest.startsWith("[") ? LINK_PATTERN.exec(rest) : null;

    if (linkMatch) {
      const [match, label, href] = linkMatch;

      if (!isGuideHref(href)) {
        throw new RichTextError(`Link "${label}" must use an https URL or a path starting with /.`);
      }

      flushText();
      inlines.push({ kind: "link", text: label, href });
      index += match.length;
      continue;
    }

    text += paragraph[index];
    index += 1;
  }

  flushText();

  return inlines;
}

/**
 * Parse guide rich text
 *
 * Splits paragraphs on blank lines and joins the lines inside one with a space. Throws `RichTextError` on an unclosed
 * span or an unsafe link.
 */
export function parseRichText(source: string): RichText {
  return source
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.replace(/\s*\n\s*/g, " ").trim())
    .filter((paragraph) => paragraph !== "")
    .map(parseParagraph);
}

/** Get the plain text of a rich text value, for labels, titles, and comparisons. */
export function plainText(value: RichText): string {
  return value.map((paragraph) => paragraph.map((inline) => inline.text).join("")).join("\n\n");
}
