import { normalizePairingSecret, type RandomBytes } from "./secret.ts";

/**
 * End-to-end encryption of the AI chat link, with WebCrypto only so the tab and the
 * companion share this code. The pairing secret is stretched with PBKDF2, then HKDF
 * derives two unrelated values from it: the room proof and the AES-GCM key the relay
 * never sees. The room id the relay routes by is the proof's SHA-256, so the relay can check
 * that a tab or a companion holds the secret, while knowing a room id reveals neither the
 * proof nor the key.
 *
 * Changing how a secret derives any of these moves every pairing to another room, which
 * `CONNECT_PROTOCOL` does not see: peers on two derivations never meet, so a change here needs
 * new salt and info strings and a release of the tab and the companion together.
 */

/** PBKDF2 iterations that stretch a pairing secret. */
export const CONNECT_KDF_ITERATIONS = 200_000;

const KDF_SALT = "drizzle-run/connect/v1/salt";
// Changing it would move every pairing to another room.
const ROOM_PROOF_INFO = "drizzle-run/connect/v1/companion-proof";
const KEY_INFO = "drizzle-run/connect/v1/key";

/** A room id: 32 bytes as unpadded base64url, 43 characters. */
export const ROOM_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** What a pairing secret derives: the room id the relay routes by and the message key it never sees. */
export interface ConnectKeys {
  roomId: string;
  key: CryptoKey;
  /**
   * What the tab and the companion show the relay to join the room, as unpadded base64url; the room id is its
   * SHA-256.
   */
  roomProof: string;
}

/** Overrides for `deriveConnectKeys`. */
export interface ConnectCryptoOptions {
  subtle?: SubtleCrypto;
  /** Tests only: both sides must use the same count. */
  iterations?: number;
}

/** Thrown when a pairing secret, base64url text, or sealed message is invalid, or WebCrypto is missing. */
export class ConnectCryptoError extends Error {
  override name = "ConnectCryptoError";
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

const BASE64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** Encode bytes as unpadded base64url. */
export function toBase64Url(bytes: Uint8Array): string {
  let output = "";

  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index] ?? 0;
    const b = bytes[index + 1];
    const c = bytes[index + 2];
    const chunk = (a << 16) | ((b ?? 0) << 8) | (c ?? 0);

    output += BASE64URL_ALPHABET[(chunk >> 18) & 63];
    output += BASE64URL_ALPHABET[(chunk >> 12) & 63];

    if (b !== undefined) {
      output += BASE64URL_ALPHABET[(chunk >> 6) & 63];
    }

    if (c !== undefined) {
      output += BASE64URL_ALPHABET[chunk & 63];
    }
  }

  return output;
}

/**
 * Decode unpadded base64url text
 *
 * Throws `ConnectCryptoError` on characters outside the alphabet or an impossible length.
 */
export function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) {
    throw new ConnectCryptoError("Not base64url text.");
  }

  const bytes = new Uint8Array(Math.floor((text.length * 3) / 4));
  let byteCount = 0;

  for (let index = 0; index < text.length; index += 4) {
    const sextets = [0, 1, 2, 3].map((offset) => {
      const character = text[index + offset];

      return character === undefined ? -1 : BASE64URL_ALPHABET.indexOf(character);
    });
    const [first = 0, second = 0, third = -1, fourth = -1] = sextets;
    const chunk = (first << 18) | (second << 12) | (Math.max(third, 0) << 6) | Math.max(fourth, 0);

    bytes[byteCount++] = (chunk >> 16) & 255;

    if (third >= 0) {
      bytes[byteCount++] = (chunk >> 8) & 255;
    }

    if (fourth >= 0) {
      bytes[byteCount++] = chunk & 255;
    }
  }

  return bytes.slice(0, byteCount);
}

function getDefaultSubtle(): SubtleCrypto {
  if (globalThis.crypto?.subtle === undefined) {
    throw new ConnectCryptoError("WebCrypto is not available here.");
  }

  return globalThis.crypto.subtle;
}

const IV_BYTES = 12;

/**
 * Derive the room id and the message key from a pairing secret
 *
 * Throws `ConnectCryptoError` when `secret` is not a pairing secret or WebCrypto is missing.
 */
export async function deriveConnectKeys(secret: string, options: ConnectCryptoOptions = {}): Promise<ConnectKeys> {
  const normalizedSecret = normalizePairingSecret(secret);

  if (normalizedSecret === undefined) {
    throw new ConnectCryptoError("That is not a Drizzle Run pairing code.");
  }

  // Stretch the secret
  const subtle = options.subtle ?? getDefaultSubtle();
  const passwordKey = await subtle.importKey("raw", encoder.encode(normalizedSecret), "PBKDF2", false, ["deriveBits"]);
  const stretchedBits = await subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: encoder.encode(KDF_SALT),
      iterations: options.iterations ?? CONNECT_KDF_ITERATIONS,
    },
    passwordKey,
    256,
  );

  // Derive the room id and the message key
  const masterKey = await subtle.importKey("raw", stretchedBits, "HKDF", false, ["deriveBits", "deriveKey"]);
  const createHkdfParams = (info: string) => ({
    name: "HKDF",
    hash: "SHA-256",
    salt: new Uint8Array(0),
    info: encoder.encode(info),
  });
  const proofBits = await subtle.deriveBits(createHkdfParams(ROOM_PROOF_INFO), masterKey, 256);
  const roomProof = toBase64Url(new Uint8Array(proofBits));
  const key = await subtle.deriveKey(createHkdfParams(KEY_INFO), masterKey, { name: "AES-GCM", length: 256 }, false, [
    "encrypt",
    "decrypt",
  ]);

  return { roomId: await toRoomId(roomProof, subtle), key, roomProof };
}

/**
 * Get the room id a room proof opens
 *
 * The proof's SHA-256, as unpadded base64url: the relay compares it with the room a tab or a companion asks for, so
 * only a holder of the pairing secret can join the room, fill its tabs, or replace its companion.
 */
export async function toRoomId(roomProof: string, subtle = getDefaultSubtle()): Promise<string> {
  const digest = await subtle.digest("SHA-256", encoder.encode(roomProof));

  return toBase64Url(new Uint8Array(digest));
}

/**
 * Encrypt text for the chat link
 *
 * Encrypts `plaintext` as `<iv>.<ciphertext>`, binding `associated` (not secret, checked on open).
 */
export async function sealText(
  key: CryptoKey,
  plaintext: string,
  associated: string,
  options: { subtle?: SubtleCrypto; random?: RandomBytes } = {},
): Promise<string> {
  const subtle = options.subtle ?? getDefaultSubtle();
  const getRandomBytes = options.random ?? ((bytes) => crypto.getRandomValues(bytes));
  const iv = getRandomBytes(new Uint8Array(IV_BYTES));
  const ciphertext = await subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode(associated) },
    key,
    encoder.encode(plaintext),
  );

  return `${toBase64Url(iv)}.${toBase64Url(new Uint8Array(ciphertext))}`;
}

/**
 * Decrypt what `sealText` made
 *
 * A wrong key, a changed byte, or other associated data throws `ConnectCryptoError`.
 */
export async function openText(
  key: CryptoKey,
  sealed: string,
  associated: string,
  options: { subtle?: SubtleCrypto } = {},
): Promise<string> {
  const subtle = options.subtle ?? getDefaultSubtle();
  const [ivText, bodyText, extra] = sealed.split(".");

  if (ivText === undefined || bodyText === undefined || extra !== undefined) {
    throw new ConnectCryptoError("Not a sealed message.");
  }

  const iv = fromBase64Url(ivText);

  if (iv.length !== IV_BYTES) {
    throw new ConnectCryptoError("Not a sealed message.");
  }

  try {
    const plaintext = await subtle.decrypt(
      { name: "AES-GCM", iv, additionalData: encoder.encode(associated) },
      key,
      fromBase64Url(bodyText),
    );

    return decoder.decode(plaintext);
  } catch (cause) {
    throw new ConnectCryptoError("The message could not be decrypted with this pairing.", { cause });
  }
}
