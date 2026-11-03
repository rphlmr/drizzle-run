import { DIALECTS, type Dialect } from "@drizzle-run/core/catalog";

import { listOgDialects, type OgSide } from "../worker/og-images.ts";
import { ogHost, toReleaseLabel, type OgCard } from "./cards.ts";

/** A node of the element tree Satori draws: the shape of a React element, without React. */
export interface OgElement {
  type: string;
  key: null;
  props: {
    style?: Record<string, string | number>;
    children?: OgChild | OgChild[];
    src?: string;
    width?: number;
    height?: number;
  };
}

type OgChild = OgElement | string;

/** The image size Open Graph and X's large summary card both expect. */
export const ogImageSize = { width: 1200, height: 630 };

/** The fonts the layout names, as the renderer registers them. */
export const ogFontFamilies = { display: "Bricolage Grotesque", sans: "Geist", mono: "JetBrains Mono" };

// The dark theme's tokens (src/design/tokens.css), at twice the 600 x 315 mockup's sizes.
const colors = {
  background: "#111111",
  text: "#f3f4f6",
  muted: "#d1d1d1",
  faint: "#a3a3a3",
  chip: "#1a1a1a",
  chipBorder: "#e5e5e5",
  lime: "#c5f74f",
  ink: "#0a0a0a",
  bugText: "#ffb224",
  bugBackground: "#2e1d0e",
};

const shareCopy = {
  playground: {
    title: "A shared Drizzle playground",
    description: "Open it to read the code and run it in your browser, on a fresh database.",
  },
  "bug-repros": {
    title: "A Drizzle bug repro",
    description: "A minimal case that shows the bug. Run it in your browser to see it happen.",
  },
} satisfies Record<Extract<OgCard, { kind: "share" }>["topic"], { title: string; description: string }>;

const logoSvg = [
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">`,
  `<rect x="2" y="2" width="30" height="30" rx="8" fill="${colors.chipBorder}"/>`,
  `<rect x="0.75" y="0.75" width="28.5" height="28.5" rx="7.25" fill="${colors.lime}" stroke="${colors.chipBorder}" stroke-width="1.5"/>`,
  `<g transform="translate(5.5 10) scale(0.05994)" fill="none" stroke="${colors.ink}" stroke-width="30" stroke-linecap="round">`,
  `<line x1="59" y1="74" x2="14" y2="151.5"/><line x1="155" y1="14" x2="110" y2="92"/>`,
  `<line x1="207" y1="74" x2="162" y2="151.5"/><line x1="303" y1="14.5" x2="258" y2="92"/></g></svg>`,
].join("");

// Lucide's `bug`, `badge-check`, and `play`, as the app draws them.
const bugIconPaths = [
  "M12 20v-9",
  "M14 7a4 4 0 0 1 4 4v3a6 6 0 0 1-12 0v-3a4 4 0 0 1 4-4z",
  "M14.12 3.88 16 2",
  "M21 21a4 4 0 0 0-3.81-4",
  "M21 5a4 4 0 0 1-3.55 3.97",
  "M22 13h-4",
  "M3 21a4 4 0 0 1 3.81-4",
  "M3 5a4 4 0 0 0 3.55 3.97",
  "M6 13H2",
  "m8 2 1.88 1.88",
  "M9 7.13V6a3 3 0 1 1 6 0v1.13",
];
const badgeCheckIconPaths = [
  "M3.85 8.62a4 4 0 0 1 4.78-4.77 4 4 0 0 1 6.74 0 4 4 0 0 1 4.78 4.78 4 4 0 0 1 0 6.74 4 4 0 0 1-4.77 4.78 4 4 0 0 1-6.75 0 4 4 0 0 1-4.78-4.77 4 4 0 0 1 0-6.76Z",
  "m16 9-5.5 5.5L8 12",
];
const playIconPath = "M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z";

/** Build the element tree for a link preview card. */
export function layoutOgCard(card: OgCard): OgElement {
  const { title, description } = card.kind === "share" ? shareCopy[card.topic] : card;
  const bugRepro = card.kind === "share" && card.topic === "bug-repros";

  return element(
    "div",
    {
      display: "flex",
      flexDirection: "column",
      // Satori sizes the content box, so without border-box the padding pushes the mark and the footer off the image.
      boxSizing: "border-box",
      width: ogImageSize.width,
      height: ogImageSize.height,
      padding: "48px 64px",
      backgroundColor: colors.background,
      color: colors.text,
      fontFamily: ogFontFamilies.sans,
      ...(bugRepro ? { borderLeft: `12px solid ${colors.bugText}` } : {}),
    },
    [
      layoutHeader(card),
      element(
        "div",
        {
          display: "block",
          flexShrink: 0,
          marginTop: 40,
          maxWidth: 1000,
          fontFamily: ogFontFamilies.display,
          fontWeight: 700,
          fontSize: 80,
          letterSpacing: "-0.02em",
          lineHeight: 1.02,
          lineClamp: 2,
        },
        title,
      ),
      element(
        "div",
        {
          display: "block",
          flexShrink: 0,
          marginTop: 16,
          fontSize: 28,
          lineHeight: 1.4,
          color: colors.muted,
          lineClamp: 2,
        },
        description,
      ),
      element(
        "div",
        {
          display: "flex",
          flexShrink: 0,
          padding: "24px 0",
          marginTop: "auto",
          marginBottom: "auto",
        },
        runButton(bugRepro ? colors.bugText : colors.lime),
      ),
      layoutFooter(card),
    ],
  );
}

function layoutHeader(card: OgCard): OgElement {
  const marks: OgElement[] = [];

  if (card.kind === "example") {
    marks.push(
      markChip("Official", badgeCheckIconPaths, {
        color: colors.ink,
        background: colors.lime,
        border: colors.chipBorder,
      }),
    );
  }

  if (card.kind === "share" && card.topic === "bug-repros") {
    marks.push(
      markChip("Bug repro", bugIconPaths, {
        color: colors.bugText,
        background: colors.bugBackground,
        border: colors.bugText,
      }),
    );
  }

  return element("div", { display: "flex", alignItems: "center", gap: 16 }, [
    image(toSvgDataUri(logoSvg), 52),
    element("div", { fontFamily: ogFontFamilies.display, fontWeight: 700, fontSize: 30 }, "Drizzle Run"),
    ...marks.map((mark) => element("div", { display: "flex", marginLeft: "auto" }, mark)),
  ]);
}

function layoutFooter(card: OgCard): OgElement {
  const runtime = card.kind === "page" ? null : card.runtime;
  const runsOn: OgElement[] = [];

  if (runtime !== null) {
    const [first, second] = runtime.sides;
    const twoDatabases = listOgDialects(runtime).length > 1;

    runsOn.push(
      ...(twoDatabases
        ? [versionChip(first, first.dialect)]
        : [chip(DIALECTS[first.dialect].label), versionChip(first)]),
    );

    if (second !== undefined) {
      runsOn.push(
        element("div", { fontFamily: ogFontFamilies.display, fontWeight: 700, fontSize: 28, color: colors.lime }, "vs"),
        versionChip(second, twoDatabases ? second.dialect : undefined),
      );
    }
  }

  return element("div", { display: "flex", alignItems: "center", gap: 12, flexShrink: 0 }, [
    ...runsOn,
    element("div", { marginLeft: "auto", fontFamily: ogFontFamilies.mono, fontSize: 22, color: colors.faint }, ogHost),
  ]);
}

/** A side's version and release, led by its database when `dialect` is given. */
function versionChip({ ormVersion, guestFlavor }: OgSide, dialect?: Dialect): OgElement {
  const label = toReleaseLabel(ormVersion);

  return chip([
    // Its own element, so the chip's gap sets it apart from the version text.
    ...(dialect === undefined ? [] : [element("div", { color: colors.text }, DIALECTS[dialect].label)]),
    ormVersion,
    element(
      "div",
      { fontFamily: ogFontFamilies.sans, fontSize: 20, opacity: 0.75 },
      guestFlavor === "effect" ? `${label} + Effect` : label,
    ),
  ]);
}

function runButton(background: string): OgElement {
  return element(
    "div",
    {
      display: "flex",
      alignItems: "center",
      gap: 16,
      padding: "14px 36px 14px 28px",
      backgroundColor: background,
      color: colors.ink,
      border: `3px solid ${colors.chipBorder}`,
      borderRadius: 18,
      boxShadow: `6px 6px 0 ${colors.chipBorder}`,
      fontFamily: ogFontFamilies.display,
      fontWeight: 700,
      fontSize: 32,
    },
    [image(toSvgDataUri(toIconSvg([playIconPath], colors.ink, colors.ink)), 26), "Run"],
  );
}

function chip(text: OgChild | OgChild[]): OgElement {
  return element(
    "div",
    {
      display: "flex",
      alignItems: "center",
      gap: 10,
      padding: "6px 16px",
      border: `2px solid ${colors.chipBorder}`,
      borderRadius: 999,
      backgroundColor: colors.chip,
      color: colors.muted,
      fontFamily: ogFontFamilies.mono,
      fontSize: 22,
      whiteSpace: "nowrap",
    },
    text,
  );
}

function markChip(
  label: string,
  iconPaths: readonly string[],
  palette: { color: string; background: string; border: string },
): OgElement {
  return element(
    "div",
    {
      display: "flex",
      alignItems: "center",
      gap: 10,
      padding: "8px 20px",
      border: `2px solid ${palette.border}`,
      borderRadius: 999,
      backgroundColor: palette.background,
      color: palette.color,
      fontSize: 24,
      fontWeight: 500,
    },
    [image(toSvgDataUri(toIconSvg(iconPaths, palette.color, "none")), 26), label],
  );
}

function image(src: string, size: number): OgElement {
  return { type: "img", key: null, props: { src, width: size, height: size } };
}

function element(type: string, style: Record<string, string | number>, children: OgChild | OgChild[]): OgElement {
  return { type, key: null, props: { style, children } };
}

function toIconSvg(paths: readonly string[], stroke: string, fill: string): string {
  const shapes = paths.map((path) => `<path d="${path}"/>`).join("");

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="${fill}" stroke="${stroke}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${shapes}</svg>`;
}

function toSvgDataUri(svg: string): string {
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}
