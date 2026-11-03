import type { ExampleSummary } from "../worker/examples.generated.ts";
import {
  listShareImageVariants,
  resolveShareImageVariant,
  toShareImagePath,
  type OgRuntime,
} from "../worker/og-images.ts";

/**
 * What a link preview image shows
 *
 * Every image is drawn at build time, so the Worker spends no CPU on them. A page card names one of the app's pages
 * and an example card an official example. A share card stands for every shared link of its Community topic, database,
 * and versions (worker/og-images.ts): a share's own title and description reach previews through its text tags.
 */
export type OgCard =
  | { kind: "page"; title: string; description: string }
  | { kind: "example"; title: string; description: string; runtime: OgRuntime }
  | { kind: "share"; topic: "playground" | "bug-repros"; runtime: OgRuntime | null };

/** A card and the path under `public/` its image is written to. */
export interface OgImage {
  /** Relative to `public/`, such as `og/examples/transactions.png`. The Worker names the same paths. */
  path: string;
  card: OgCard;
}

/** The host the footer names. */
export const ogHost = "drizzle.run";

/**
 * List every link preview image
 *
 * The page titles repeat the pages' own headings, and the descriptions their meta descriptions
 * (worker/document-meta.ts), the home one cut to a line to leave room for the Run button.
 */
export function listOgImages(examples: readonly ExampleSummary[]): OgImage[] {
  return [
    {
      path: "og/home.png",
      card: {
        kind: "page",
        title: "Write a schema. Seed it. Run a query.",
        description: "Real Drizzle ORM and Kit run in your browser, with a fresh database on every run.",
      },
    },
    {
      path: "og/examples.png",
      card: {
        kind: "page",
        title: "Official examples",
        description:
          "Official Drizzle ORM examples you can run in your browser: queries, schema, transactions and more.",
      },
    },
    {
      path: "og/community.png",
      card: {
        kind: "page",
        title: "Community shares",
        description: "Drizzle ORM playgrounds the community shared. Open a copy and run it in your browser.",
      },
    },
    ...examples.map((example) => ({
      path: `og/examples/${example.slug}.png`,
      card: {
        kind: "example" as const,
        title: example.title,
        description: example.description,
        runtime: toExampleRuntime(example),
      },
    })),
    ...listShareImageVariants().map((variant) => ({
      path: toShareImagePath(variant).slice(1),
      card: { kind: "share" as const, ...variant },
    })),
  ];
}

/**
 * What an example's card says it runs: each side's database, version and flavor, in the order a share's card puts them
 *
 * Throws for a side the catalog no longer runs, which a published example rules out.
 */
function toExampleRuntime(example: ExampleSummary): OgRuntime {
  const { runtime } = resolveShareImageVariant("playground", example.sides);

  if (runtime === null) {
    throw new Error(`Expected examples/${example.slug} to run on versions the catalog ships.`);
  }

  return runtime;
}

/** A version's release label in the UI: Legacy for 0.x, RC for a 1.x pre-release, Latest for a stable 1.x. */
export function toReleaseLabel(ormVersion: string): "Legacy" | "RC" | "Latest" {
  if (ormVersion.startsWith("0.")) {
    return "Legacy";
  }

  return ormVersion.includes("-") ? "RC" : "Latest";
}
