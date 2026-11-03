import type { Diagnostic } from "@drizzle-run/core/contracts";
import { RUN_ERROR_DIAGNOSTIC_CODE } from "@drizzle-run/core/contracts";

type MappedSegment = {
  generatedColumn: number;
  source?: string;
  line?: number;
  column?: number;
};

const base64Alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const projectSourcePrefix = "drizzle-run-project:";

// Errors thrown in the guest realm fail `instanceof Error` here, so read the message structurally.
function getErrorMessage(error: unknown) {
  return error && typeof error === "object" && "message" in error && typeof error.message === "string"
    ? error.message
    : String(error);
}

function decodeVlqFields(segment: string): number[] {
  const fields: number[] = [];
  let value = 0;
  let shift = 0;

  for (const char of segment) {
    const digit = base64Alphabet.indexOf(char);
    value += (digit & 31) * 2 ** shift;

    if (digit & 32) {
      shift += 5;
      continue;
    }

    fields.push((value & 1 ? -1 : 1) * Math.floor(value / 2));
    value = 0;
    shift = 0;
  }

  return fields;
}

/**
 * Create an error locator for a compiled bundle
 *
 * Decodes the bundle's trusted esbuild source map and returns a function that maps an error's first project stack
 * frame (following `cause` chains) to a diagnostic. The locator yields `undefined` for frames outside project files.
 */
export function createErrorLocator(json: string): (error: unknown) => Diagnostic | undefined {
  const sourceMap: { sources: string[]; mappings: string } = JSON.parse(json);

  // Generated columns reset per line, while source and original positions are deltas across the whole mapping.
  let sourceIndex = 0;
  let originalLine = 0;
  let originalColumn = 0;
  const segmentsByLine = sourceMap.mappings.split(";").map((line) => {
    let generatedColumn = 0;

    return line
      .split(",")
      .filter(Boolean)
      .map((segment): MappedSegment => {
        const fields = decodeVlqFields(segment);
        generatedColumn += fields[0];

        if (fields.length < 4) {
          return { generatedColumn };
        }

        sourceIndex += fields[1];
        originalLine += fields[2];
        originalColumn += fields[3];

        return {
          generatedColumn,
          source: sourceMap.sources[sourceIndex],
          line: originalLine + 1,
          column: originalColumn + 1,
        };
      });
  });

  return (error) => {
    const seen = new Set<object>();
    let current = error;

    while (current && typeof current === "object" && !seen.has(current)) {
      seen.add(current);

      if ("stack" in current && typeof current.stack === "string") {
        for (const frame of current.stack.matchAll(/drizzle-run-bundle\.js:(\d+):(\d+)/g)) {
          const segments = segmentsByLine[Number(frame[1]) - 1] ?? [];
          const column = Number(frame[2]) - 1;
          const position = segments.toReversed().find((segment) => segment.generatedColumn <= column);

          if (position?.source?.startsWith(projectSourcePrefix)) {
            return {
              severity: "error",
              code: RUN_ERROR_DIAGNOSTIC_CODE,
              source: position.source.slice(projectSourcePrefix.length),
              line: position.line,
              column: position.column,
              message: getErrorMessage(error),
            };
          }
        }
      }

      current = "cause" in current ? current.cause : undefined;
    }

    return undefined;
  };
}
