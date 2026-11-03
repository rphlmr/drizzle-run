const FIRST_NAMES = ["Ada", "Grace", "Linus", "Margaret", "Edsger", "Barbara"];
const LAST_NAMES = ["Lovelace", "Hopper", "Torvalds", "Hamilton", "Dijkstra", "Liskov"];
const LOREM_WORDS = ["lorem", "ipsum", "dolor", "sit", "amet", "consectetur", "adipiscing", "elit"];

/** Create one independent Mulberry32 stream from an unsigned 32-bit seed. */
export function createRandomGenerator(seed: number): () => number {
  let state = seed >>> 0;

  return function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);

    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** Create a run's immutable helpers with a random stream separate from Math.random. */
export function createPlaygroundTools({
  seed,
  display,
}: {
  seed: number;
  display: (label: string, values: unknown[]) => void;
}) {
  const next = createRandomGenerator(seed);

  function integer(min = 0, max = 999_999) {
    const lower = Math.ceil(Math.min(min, max));

    return lower + Math.floor(next() * (Math.floor(Math.max(min, max)) - lower + 1));
  }

  function pick(values: string[]) {
    return values[integer(0, values.length - 1)];
  }

  function uuid() {
    const bytes = Array.from({ length: 16 }, () => integer(0, 255));
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    const hex = bytes.map((value) => value.toString(16).padStart(2, "0"));

    return [hex.slice(0, 4), hex.slice(4, 6), hex.slice(6, 8), hex.slice(8, 10), hex.slice(10)]
      .map((part) => part.join(""))
      .join("-");
  }

  function firstName() {
    return pick(FIRST_NAMES);
  }

  function lastName() {
    return pick(LAST_NAMES);
  }

  function email() {
    const address = `${firstName()}.${lastName()}${integer(1, 999)}`.toLowerCase();

    return `${address}@example.test`;
  }

  const random = Object.freeze({
    uuid,
    integer,
    firstName,
    lastName,
    fullName: () => `${firstName()} ${lastName()}`,
    sequence: (length: number) => Array.from({ length }, (_, index) => index + 1),
    decimal: (min = 0, max = 100) => (min + next() * (max - min)).toFixed(2),
    lorem: (wordCount = 8) => Array.from({ length: wordCount }, () => pick(LOREM_WORDS)).join(" "),
    email,
    date: (start = new Date("2000-01-01T00:00:00.000Z"), end = new Date("2030-01-01T00:00:00.000Z")) =>
      new Date(start.getTime() + next() * (end.getTime() - start.getTime())),
    url: () => `https://example.test/${uuid()}`,
    imageUrl: () => `https://images.example.test/${uuid()}.webp`,
    array: <Value>(length: number, generator: (value: undefined, index: number) => Value) =>
      Array.from({ length }, generator),
  });

  return Object.freeze({
    random,
    wait: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    display(label: string, ...values: unknown[]) {
      if (typeof label !== "string" || !label.trim() || !values.length) {
        throw new TypeError("$.display requires a label and values");
      }

      display(label, values);
    },
  });
}
