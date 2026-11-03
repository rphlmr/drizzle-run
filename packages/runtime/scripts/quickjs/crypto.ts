import { Buffer } from "node:buffer";

import { sha256Bytes } from "@drizzle-run/core/hash";
import crypto from "unenv/node/crypto";

export * from "unenv/node/crypto";

/** Hash project migration text without exposing a host cryptography callback. Only SHA-256 is supported. */
export function createHash(algorithm: string) {
  if (algorithm.toLowerCase() !== "sha256") {
    throw new Error(`QuickJS project hashing supports sha256, received ${algorithm}`);
  }

  const chunks: Uint8Array[] = [];
  const hash = {
    update(value: string | Uint8Array) {
      chunks.push(typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value));

      return hash;
    },
    digest(encoding?: "hex") {
      const bytes = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.byteLength, 0));
      let offset = 0;

      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }

      const digest = Buffer.from(sha256Bytes(bytes));

      return encoding === "hex" ? digest.toString("hex") : digest;
    },
  };

  return hash;
}

export default { ...crypto, createHash };
