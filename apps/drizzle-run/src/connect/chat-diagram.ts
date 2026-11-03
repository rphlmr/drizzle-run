import mermaid from "mermaid";

// A diagram's own directives (`%%{init: …}%%` or front matter) cannot change these. Mermaid locks the
// first six; the others could swap the look of the chat or bring styles that point outside the page.
const LOCKED_SETTINGS = [
  "secure",
  "securityLevel",
  "startOnLoad",
  "maxTextSize",
  "suppressErrorRendering",
  "maxEdges",
  "theme",
  "themeCSS",
  "themeVariables",
  "darkMode",
  "fontFamily",
  "htmlLabels",
];

let renderCount = 0;

/**
 * Draw a mermaid diagram
 *
 * Returns the diagram as an SVG data URL, for an `<img>`: a browser never runs scripts or loads
 * anything from an image's SVG, so a reply cannot reach the network or the page through it.
 * Mermaid itself runs at its strict security level, with labels drawn as SVG text so they show
 * inside an image. Throws mermaid's own error when the source does not parse.
 */
export async function renderDiagramImage(source: string, theme: "light" | "dark"): Promise<string> {
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    theme: theme === "dark" ? "dark" : "neutral",
    htmlLabels: false,
    secure: LOCKED_SETTINGS,
    suppressErrorRendering: true,
  });

  renderCount += 1;

  const { svg } = await mermaid.render(`chat-diagram-${renderCount}`, source);

  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
