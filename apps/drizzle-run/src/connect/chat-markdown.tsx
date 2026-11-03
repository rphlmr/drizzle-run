import { CheckIcon, CopyIcon, ImageIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Children, createContext, useContext, useEffect, useRef, useState, useSyncExternalStore } from "react";
import Markdown, { type Components, defaultUrlTransform, type UrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";

import { cn } from "../lib/utils";
import { useCopyFeedback } from "../ui/clipboard";

/** Fence names agents use, mapped to Monaco's language ids. Anything else shows as plain text. */
const MONACO_LANGUAGES: Readonly<Record<string, string>> = {
  ts: "typescript",
  typescript: "typescript",
  tsx: "typescript",
  js: "javascript",
  javascript: "javascript",
  jsx: "javascript",
  sql: "sql",
  json: "json",
  sh: "shell",
  bash: "shell",
  shell: "shell",
};

const COPIED_LABEL_MS = 1_500;
const copyLabels = { idle: "Copy", copied: "Copied", failed: "Couldn't copy" } as const;

// An image never runs scripts, SVG included.
const INLINE_IMAGE_DATA = /^data:image\/(?:png|jpeg|gif|webp|avif|svg\+xml)[;,]/i;

/** How the chat shows an image of a reply: drawn in place, or as a link the user may open. */
export type ChatImage = { kind: "inline"; src: string } | { kind: "link"; href: string; host: string };

const InsideCodeBlock = createContext<false | { open: boolean }>(false);

const StreamingEnd = createContext<number | undefined>(undefined);

const components: Components = {
  p: ({ children }) => <p className="m-0">{children}</p>,
  strong: ({ children }) => <strong className="font-semibold text-text">{children}</strong>,
  em: ({ children }) => <em>{children}</em>,
  a: ({ href, children }) => <ChatLink href={href}>{children}</ChatLink>,
  img: ({ src, alt }) => <ChatImageView src={typeof src === "string" ? src : undefined} alt={alt} />,
  ul: ({ children }) => <ul className="m-0 flex list-disc flex-col gap-1 pl-5">{children}</ul>,
  ol: ({ children }) => <ol className="m-0 flex list-decimal flex-col gap-1 pl-5">{children}</ol>,
  li: ({ children }) => (
    <li className="pl-0.5 *:data-[slot=chat-code]:mt-2 *:data-[slot=chat-code]:mb-1 [&>ol]:mt-1 [&>ul]:mt-1">
      {children}
    </li>
  ),
  h1: ({ children }) => <h3 className="m-0 text-[14px] font-semibold text-text">{children}</h3>,
  h2: ({ children }) => <h3 className="m-0 text-[14px] font-semibold text-text">{children}</h3>,
  h3: ({ children }) => <h3 className="m-0 text-[13.5px] font-semibold text-text">{children}</h3>,
  blockquote: ({ children }) => (
    <blockquote className="m-0 border-l-2 border-border pl-3 text-muted">{children}</blockquote>
  ),
  hr: () => <hr className="m-0 border-0 border-t border-border" />,
  table: ({ children }) => (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-[12.5px]">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border-b border-border px-2 py-1 text-left font-semibold text-text">{children}</th>
  ),
  td: ({ children }) => <td className="border-b border-border px-2 py-1 align-top">{children}</td>,
  pre: ({ node, children }) => <CodeBlockScope end={node?.position?.end.offset}>{children}</CodeBlockScope>,
  code: ({ className, children }) => <ChatCode className={className}>{children}</ChatCode>,
};

/**
 * Chat markdown
 *
 * An agent's reply as GitHub-flavored markdown: paragraphs, lists, tables, links, inline code and
 * fenced code blocks colored like the editor, and mermaid blocks drawn as diagrams. Raw HTML in the
 * reply is never rendered. Links open in a new tab and name the site they lead to. Images draw in
 * place only from a data or blob URL or from Drizzle Run itself; any other image is a link the user
 * may open, so a reply can never make the page load something from another site. While `streaming`, a diagram
 * that runs to the end of the text may still be arriving, so it shows its source until more follows.
 */
export function ChatMarkdown({
  text,
  streaming = false,
  className,
}: {
  text: string;
  streaming?: boolean;
  className?: string;
}) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-2.5", className)}>
      <StreamingEnd.Provider value={streaming ? text.length : undefined}>
        <Markdown remarkPlugins={[remarkGfm]} components={components} urlTransform={transformChatUrl}>
          {text}
        </Markdown>
      </StreamingEnd.Provider>
    </div>
  );
}

function CodeBlockScope({ end, children }: { end: number | undefined; children?: ReactNode }) {
  const streamingEnd = useContext(StreamingEnd);

  return (
    <InsideCodeBlock.Provider value={{ open: streamingEnd !== undefined && end === streamingEnd }}>
      {children}
    </InsideCodeBlock.Provider>
  );
}

/**
 * Chat image policy
 *
 * Decides how the chat shows an image a reply links to. A data URL of a known image format, a blob
 * URL, and a same-origin path outside `/api/` draw in place; an image on another site becomes a link
 * that names its host, never fetched until the user opens it. Returns null for a source the chat
 * cannot use (missing, unparsable, or a scheme other than http and https).
 */
export function toChatImage(src: string | undefined, pageOrigin: string): ChatImage | null {
  if (src === undefined || src === "") {
    return null;
  }

  if (INLINE_IMAGE_DATA.test(src) || src.startsWith("blob:")) {
    return { kind: "inline", src };
  }

  const url = toUrl(src, pageOrigin);

  if (url === null || (url.protocol !== "https:" && url.protocol !== "http:")) {
    return null;
  }

  if (url.origin === pageOrigin) {
    return url.pathname.startsWith("/api/") ? null : { kind: "inline", src: url.href };
  }

  return { kind: "link", href: url.href, host: url.host };
}

/**
 * Link destination label
 *
 * The site a chat link leads to, shown beside it so its text cannot pass for another address: the
 * host of a web link on another site, "email" for a mailto link, or the scheme of any other link.
 * Returns null for a link that stays on this page's origin or does not parse.
 */
export function toLinkDestination(href: string | undefined, pageOrigin: string): string | null {
  const url = href === undefined ? null : toUrl(href, pageOrigin);

  if (url === null || url.origin === pageOrigin) {
    return null;
  }

  if (url.protocol === "https:" || url.protocol === "http:") {
    return url.host;
  }

  return url.protocol === "mailto:" ? "email" : url.protocol.replace(/:$/, "");
}

// react-markdown drops data and blob URLs; keep them for images only, which `toChatImage` checks again.
const transformChatUrl: UrlTransform = (url, key, node) => {
  if (key === "src" && node.tagName === "img" && (INLINE_IMAGE_DATA.test(url) || url.startsWith("blob:"))) {
    return url;
  }

  return defaultUrlTransform(url);
};

function toUrl(value: string, pageOrigin: string): URL | null {
  try {
    return new URL(value, pageOrigin);
  } catch {
    return null;
  }
}

function getPageOrigin(): string {
  return typeof window === "undefined" ? "https://drizzle.run" : window.location.origin;
}

function ChatLink({ href, children }: { href: string | undefined; children?: ReactNode }) {
  const destination = toLinkDestination(href, getPageOrigin());
  const showsItself = typeof children === "string" && children === href;

  return (
    <>
      <a href={href} target="_blank" rel="noreferrer" className="font-semibold text-accent-text">
        {children}
      </a>
      {destination !== null && !showsItself && <LinkDestination name={destination} />}
    </>
  );
}

function LinkDestination({ name }: { name: string }) {
  return (
    <span className="ml-1 text-[11.5px] font-normal text-muted" data-slot="link-destination">
      · {name}
    </span>
  );
}

function ChatImageView({ src, alt }: { src: string | undefined; alt: string | undefined }) {
  const image = toChatImage(src, getPageOrigin());
  const label = alt === undefined || alt === "" ? "image" : alt;

  if (image === null) {
    return <span className="text-muted">[{label}]</span>;
  }

  if (image.kind === "inline") {
    return <img src={image.src} alt={alt ?? ""} className="max-h-120 max-w-full rounded-[10px] border border-border" />;
  }

  return (
    <>
      <a
        href={image.href}
        target="_blank"
        rel="noreferrer"
        className="inline-flex items-center gap-1 font-semibold text-accent-text"
        data-slot="remote-image"
      >
        <ImageIcon className="size-3.5" aria-hidden="true" />
        {label}
      </a>
      <LinkDestination name={image.host} />
    </>
  );
}

function ChatCode({ className, children }: { className: string | undefined; children?: ReactNode }) {
  const block = useContext(InsideCodeBlock);

  if (!block) {
    return <code className="rich-code">{children}</code>;
  }

  const fence = /language-(\S+)/.exec(className ?? "")?.[1];
  // Joined so several text nodes never gain commas.
  const code = Children.toArray(children)
    .map((child) => (typeof child === "string" || typeof child === "number" ? String(child) : ""))
    .join("")
    .replace(/\n$/, "");

  if (fence?.toLowerCase() === "mermaid") {
    return block.open ? <CodeBlock code={code} fence={fence} /> : <DiagramBlock source={code} />;
  }

  return <CodeBlock code={code} fence={fence} />;
}

/** A mermaid block: the drawn diagram once mermaid answers, or its source while it loads or if it fails. */
function DiagramBlock({ source }: { source: string }) {
  const theme = useDocumentTheme();
  const diagram = useDiagramImage(source, theme);

  if (diagram === undefined || diagram.status === "failed") {
    return (
      <div className="flex flex-col gap-1" data-slot="chat-diagram" data-state={diagram?.status ?? "loading"}>
        <CodeBlock code={source} fence="mermaid" />
        {diagram?.status === "failed" && (
          <span className="text-[11.5px] text-muted">This diagram could not be drawn.</span>
        )}
      </div>
    );
  }

  return (
    <div
      className="my-1 overflow-x-auto rounded-[10px] border border-border bg-code p-3 first:mt-0 last:mb-0"
      data-slot="chat-diagram"
      data-state="drawn"
    >
      <img src={diagram.src} alt="Diagram" className="mx-auto block max-w-full" />
    </div>
  );
}

type DiagramImage = { status: "drawn"; src: string } | { status: "failed" };

/**
 * Draws a mermaid source with the diagram module, loaded only for a reply that has one. Until it
 * answers, the block shows the source.
 */
function useDiagramImage(source: string, theme: "light" | "dark"): DiagramImage | undefined {
  const [drawn, setDrawn] = useState<{ key: string; image: DiagramImage }>();
  const key = `${theme}\n${source}`;

  useEffect(() => {
    let current = true;

    void import("./chat-diagram")
      .then((diagram) => diagram.renderDiagramImage(source, theme))
      .then(
        (src): DiagramImage => ({ status: "drawn", src }),
        (): DiagramImage => ({ status: "failed" }),
      )
      .then((image) => {
        if (current) {
          setDrawn({ key, image });
        }
      });

    return () => {
      current = false;
    };
  }, [key, source, theme]);

  return drawn?.key === key ? drawn.image : undefined;
}

function subscribeToTheme(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);

  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

  return () => observer.disconnect();
}

function getDocumentTheme(): "light" | "dark" {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

/** The theme painted on `<html>`, following the user's changes. */
function useDocumentTheme(): "light" | "dark" {
  return useSyncExternalStore(subscribeToTheme, getDocumentTheme, () => "light");
}

/** A fenced block: its language, a copy button, and the code colored by Monaco once it answers. */
function CodeBlock({ code, fence }: { code: string; fence: string | undefined }) {
  const language = fence === undefined ? undefined : MONACO_LANGUAGES[fence.toLowerCase()];
  const colorized = useColorizedCode(code, language);
  const { outcome, copy } = useCopyFeedback(COPIED_LABEL_MS);

  return (
    <div
      className="my-1 overflow-hidden rounded-[10px] border border-border bg-code first:mt-0 last:mb-0"
      data-slot="chat-code"
    >
      <div className="flex h-7 items-center justify-between border-b border-border pr-1 pl-3 text-[11px] text-muted">
        <span className="font-mono">{fence ?? "code"}</span>
        <button
          type="button"
          className="inline-flex h-6 items-center gap-1 rounded-base border-0 bg-transparent px-1.5 font-semibold text-muted hover:bg-surface-2 hover:text-text"
          onClick={() => copy(code)}
        >
          {outcome === "copied" ? (
            <CheckIcon className="size-3" aria-hidden="true" />
          ) : (
            <CopyIcon className="size-3" aria-hidden="true" />
          )}
          {copyLabels[outcome ?? "idle"]}
        </button>
      </div>
      {colorized === undefined ? (
        <pre className="px-3 py-2.5 text-text">{code}</pre>
      ) : colorized.rest === undefined ? (
        // Monaco's colorizer escapes the code; its output is only text in theme-classed spans.
        <pre className="px-3 py-2.5" dangerouslySetInnerHTML={{ __html: colorized.html }} />
      ) : (
        <pre className="px-3 py-2.5">
          <span dangerouslySetInnerHTML={{ __html: colorized.html }} />
          <span className="text-text">{colorized.rest}</span>
        </pre>
      )}
    </div>
  );
}

/**
 * Colors code with the editor's tokenizer. The chat lives beside an editor, so its module is
 * already loaded; until it answers, or for a language it does not know, the code stays plain.
 * While a streaming block grows, the whole lines colored last time stay colored and only the
 * `rest` after them shows plain until the new coloring answers, so the block never flickers.
 * Monaco's HTML names its colors by index into the theme it was made in, so a theme change colors
 * the code again and shows it plain meanwhile, instead of in another theme's colors.
 */
function useColorizedCode(code: string, language: string | undefined): { html: string; rest?: string } | undefined {
  const theme = useDocumentTheme();
  const [colorized, setColorized] = useState<{ code: string; html: string; theme: string; request: number }>();
  const requests = useRef(0);

  // A growing block asks again before the last answer lands; the newest answer wins, and an older one landing late
  // never replaces it.
  useEffect(() => {
    if (language === undefined) {
      return;
    }

    requests.current += 1;
    const request = requests.current;

    void import("../editor/environment")
      .then((editor) => editor.colorizeCode(code, language))
      .then((html) =>
        setColorized((latest) =>
          latest !== undefined && latest.request > request ? latest : { code, html, theme, request },
        ),
      )
      .catch(() => undefined);
  }, [code, language, theme]);

  if (colorized === undefined || colorized.theme !== theme) {
    return undefined;
  }

  if (colorized.code === code) {
    return { html: colorized.html };
  }

  return toColorizedPrefix(colorized, code);
}

// Monaco ends each colored line with a `<br/>`, and escapes the code, so the markup splits on it line by line.
const COLORIZED_LINE_END = "<br/>";

/**
 * The whole lines of an earlier coloring that `code` still starts with, and the code after them. The earlier last
 * line is left out, since it may have grown. Returns undefined when `code` no longer starts with those lines.
 */
export function toColorizedPrefix(
  colorized: { code: string; html: string },
  code: string,
): { html: string; rest: string } | undefined {
  const wholeLines = colorized.code.slice(0, colorized.code.lastIndexOf("\n") + 1);

  if (wholeLines === "" || !code.startsWith(wholeLines)) {
    return undefined;
  }

  const lineCount = wholeLines.split("\n").length - 1;
  const html = colorized.html
    .split(COLORIZED_LINE_END)
    .slice(0, lineCount)
    .map((line) => `${line}${COLORIZED_LINE_END}`)
    .join("");

  return { html, rest: code.slice(wholeLines.length) };
}
