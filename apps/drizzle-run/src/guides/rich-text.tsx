import type { RichTextParagraph, RichText as RichTextValue } from "@drizzle-run/core/guide";
import { Link } from "react-router";

/** One paragraph's inlines as text nodes and `code`, `strong`, and link elements, never as HTML. */
export function RichInline({ paragraph }: { paragraph: RichTextParagraph }) {
  return paragraph.map((inline, index) => {
    switch (inline.kind) {
      case "code":
        return (
          <code key={index} className="rich-code">
            {inline.text}
          </code>
        );
      case "bold":
        return (
          <strong key={index} className="font-semibold text-text">
            {inline.text}
          </strong>
        );
      case "link":
        return inline.href.startsWith("/") ? (
          <Link key={index} to={inline.href} className="font-semibold text-accent-text">
            {inline.text}
          </Link>
        ) : (
          <a key={index} href={inline.href} target="_blank" rel="noreferrer" className="font-semibold text-accent-text">
            {inline.text}
          </a>
        );
      case "text":
        return inline.text;
    }
  });
}

/** Renders rich text as paragraphs, with its inline code, bold and links. */
export function RichText({ value, className }: { value: RichTextValue; className?: string }) {
  return value.map((paragraph, index) => (
    <p key={index} className={className}>
      <RichInline paragraph={paragraph} />
    </p>
  ));
}

/** Paragraphs joined into one line, for short rail text. */
export function RichLine({ value }: { value: RichTextValue }) {
  return value.map((paragraph, index) => (
    <span key={index}>
      {index > 0 && " "}
      <RichInline paragraph={paragraph} />
    </span>
  ));
}
