/**
 * Pairing secrets, such as `k7Pq-2xZm-9fLw`: twelve characters from an alphabet without the
 * look-alikes 0, O, 1, I and l, in three groups of four. 56^12 is about 2^69.7.
 */
export const PAIRING_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Characters in a pairing secret, dashes excluded. */
export const PAIRING_SECRET_LENGTH = 12;

const GROUP_LENGTH = 4;

/** The largest multiple of the alphabet size under 256, so each kept byte maps uniformly. */
const UNBIASED_LIMIT = Math.floor(256 / PAIRING_ALPHABET.length) * PAIRING_ALPHABET.length;

/** Fill the given buffer with random bytes and return it, like `crypto.getRandomValues`. */
export type RandomBytes = (bytes: Uint8Array<ArrayBuffer>) => Uint8Array<ArrayBuffer>;

function getRandomBytes(bytes: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(bytes);
}

function toGroupedSecret(characters: string): string {
  const groups: string[] = [];

  for (let index = 0; index < characters.length; index += GROUP_LENGTH) {
    groups.push(characters.slice(index, index + GROUP_LENGTH));
  }

  return groups.join("-");
}

/**
 * Create a pairing secret
 *
 * Draws with rejection sampling so every character is equally likely.
 */
export function createPairingSecret(random: RandomBytes = getRandomBytes): string {
  let characters = "";

  while (characters.length < PAIRING_SECRET_LENGTH) {
    for (const byte of random(new Uint8Array(32))) {
      if (byte < UNBIASED_LIMIT && characters.length < PAIRING_SECRET_LENGTH) {
        characters += PAIRING_ALPHABET[byte % PAIRING_ALPHABET.length];
      }
    }
  }

  return toGroupedSecret(characters);
}

/**
 * Normalize a pairing secret
 *
 * Returns the canonical form of a typed or pasted secret (spaces and dashes ignored, case kept),
 * or undefined when it cannot be one.
 */
export function normalizePairingSecret(input: string): string | undefined {
  const characters = input.replace(/[\s-]/g, "");

  if (characters.length !== PAIRING_SECRET_LENGTH) {
    return undefined;
  }

  for (const character of characters) {
    if (!PAIRING_ALPHABET.includes(character)) {
      return undefined;
    }
  }

  return toGroupedSecret(characters);
}
