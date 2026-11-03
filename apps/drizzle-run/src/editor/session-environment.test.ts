import type { ProjectTypeEnvironment } from "@drizzle-run/runtime/type-environment";
import { describe, expect, it } from "vitest";

import { namespaceProjectTypeEnvironment } from "./session-environment";

const base = "file:///__drizzle_run_project__/same-fingerprint/";
const schemaUri = `${base}schema.ts`;
const helperUri = `${base}helpers.ts`;
const contextUri = "file:///__drizzle_run_generated__/same-fingerprint/context.d.ts";
const typeRoot =
  "file:///__drizzle_run_types__/node-postgres__at__types__pg__8.23.1__at__types__node__24.19.2/_dependencies/_node_types/%40types";
const pgEntry =
  "file:///__drizzle_run_types__/node-postgres__at__types__pg__8.23.1__at__types__node__24.19.2/_dependencies/pg/__entry__.d.ts";
const projectSource =
  'const exampleUri = "file:///__drizzle_run_project__/same-fingerprint/helpers.ts";\nimport "./helpers";';

const environment: ProjectTypeEnvironment = {
  fingerprint: "same-fingerprint",
  compilerOptions: {
    target: "ES2025",
    module: "ESNext",
    moduleResolution: "Bundler",
    lib: [
      "ES2022",
      "ES2023.Array",
      "ES2023.Collection",
      "ES2024.ArrayBuffer",
      "ES2024.Collection",
      "ES2024.Object",
      "ES2024.Promise",
      "ES2024.Regexp",
      "ES2024.String",
      "ES2025.Collection",
      "ES2025.Float16",
      "ES2025.Iterator",
      "ES2025.Promise",
      "ES2025.Regexp",
      "DOM",
      "WebWorker",
    ],
    strict: true,
    allowImportingTsExtensions: true,
    resolveJsonModule: true,
    isolatedModules: true,
    noEmit: true,
    paths: {
      pg: [pgEntry],
      "pg/*": [
        "file:///__drizzle_run_types__/node-postgres__at__types__pg__8.23.1__at__types__node__24.19.2/_dependencies/pg/*",
      ],
      "@drizzle-run/runtime/context": [contextUri],
    },
    typeRoots: [typeRoot],
  },
  files: [
    { uri: schemaUri, content: projectSource, kind: "project" },
    { uri: helperUri, content: "export const helper = true;", kind: "project" },
    { uri: contextUri, content: `export { schema } from "${schemaUri}";`, kind: "generated" },
    { uri: pgEntry, content: "export interface Client {}", kind: "library" },
  ],
};

describe("namespaceProjectTypeEnvironment", () => {
  it("should isolate identical project models and declarations for concurrent editor sessions", () => {
    const first = namespaceProjectTypeEnvironment(environment, "11111111111111111111111111111111");
    const second = namespaceProjectTypeEnvironment(environment, "22222222222222222222222222222222");

    const firstSchema = first.files.find((file) => file.kind === "project" && file.uri.endsWith("/schema.ts"));
    const secondSchema = second.files.find((file) => file.kind === "project" && file.uri.endsWith("/schema.ts"));
    const firstContext = first.files.find((file) => file.kind === "generated");
    const secondContext = second.files.find((file) => file.kind === "generated");

    expect(firstSchema?.uri).not.toBe(secondSchema?.uri);
    expect(firstContext?.uri).not.toBe(secondContext?.uri);
    // TypeScript skips absolute URI specifiers, so the context reaches its session's schema relatively.
    expect(firstContext?.content).toContain(
      '"../../../__drizzle_run_project__/11111111111111111111111111111111/same-fingerprint/schema"',
    );
    expect(secondContext?.content).toContain(
      '"../../../__drizzle_run_project__/22222222222222222222222222222222/same-fingerprint/schema"',
    );
    expect(first.compilerOptions.paths.pg).not.toEqual(second.compilerOptions.paths.pg);
    expect(first.compilerOptions.paths["pg/*"]).not.toEqual(second.compilerOptions.paths["pg/*"]);
    expect(first.compilerOptions.paths["@drizzle-run/runtime/context"]).toEqual([firstContext?.uri]);
    expect(first.compilerOptions.typeRoots).not.toEqual(second.compilerOptions.typeRoots);
    expect(first.files.find((file) => file.uri.endsWith("/schema.ts"))?.content).toBe(projectSource);
  });

  it("should reject session identifiers that are unsafe for virtual URIs", () => {
    expect(() => namespaceProjectTypeEnvironment(environment, "../shared")).toThrow(TypeError);
  });
});
