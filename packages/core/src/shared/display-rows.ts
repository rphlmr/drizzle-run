import type { DisplayResult } from "../contracts/result.ts";
import type { SerializedValue } from "../contracts/serialization.ts";

/** A JSON form of a serialized value that two values can be compared by. */
export type Comparable = null | boolean | number | string | Comparable[] | { [key: string]: Comparable };

/** How `toComparable` reads a value. */
export interface ComparableOptions {
  /** Object keys dropped at every depth. */
  ignore?: ReadonlySet<string>;
  /** Whether array order matters; it does by default. */
  ordered?: boolean;
}

/**
 * A stable form of a serialized value
 *
 * Object keys are sorted and `ignore`d keys dropped at every depth. Arrays keep their order unless `ordered` is false,
 * then they are sorted too, so two runs that return the same rows in another order compare equal.
 */
export function toComparable(value: SerializedValue, options: ComparableOptions = {}): Comparable {
  switch (value.type) {
    case "undefined":
      return ["undefined"];
    case "primitive":
      return value.value;
    case "bigint":
      return ["bigint", value.value];
    case "date":
      return ["date", value.value];
    case "array": {
      const items = value.value.map((item) => toComparable(item, options));

      if (options.ordered ?? true) {
        return ["array", items];
      }

      return ["array", items.toSorted((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))];
    }
    case "object":
      return [
        "object",
        Object.fromEntries(
          Object.keys(value.value)
            .filter((key) => options.ignore?.has(key) !== true)
            .toSorted()
            .map((key) => [key, toComparable(value.value[key], options)]),
        ),
      ];
    case "unsupported":
      return ["unsupported", value.valueType];
    case "circular":
      return ["circular", value.path];
  }
}

/** The values of the last display with this label; undefined when the run shows none. */
export function findLastDisplayValues(
  displays: readonly DisplayResult[],
  label: string,
): readonly SerializedValue[] | undefined {
  return displays.toReversed().find((display) => display.label === label)?.values;
}

/** A display's first value as rows: an array gives its items, anything else is one row, nothing is no row. */
export function toDisplayRows(values: readonly SerializedValue[]): readonly SerializedValue[] {
  const [firstValue] = values;

  if (firstValue === undefined) {
    return [];
  }

  return firstValue.type === "array" ? firstValue.value : [firstValue];
}

/** The rows of the last display with this label; undefined when the run shows none. */
export function getDisplayRows(
  displays: readonly DisplayResult[],
  label: string,
): readonly SerializedValue[] | undefined {
  const values = findLastDisplayValues(displays, label);

  return values === undefined ? undefined : toDisplayRows(values);
}
