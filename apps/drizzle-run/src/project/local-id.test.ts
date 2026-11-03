import { afterEach, expect, it, vi } from "vitest";

import { createLocalId } from "./local-id";
import { importProjectValue, readProjectJson } from "./project-file";
import { createProject } from "./projects";

afterEach(() => vi.unstubAllGlobals());

it("should create distinct UUID v4 project/import IDs without secure-context APIs", () => {
  const getRandomValues = crypto.getRandomValues.bind(crypto);
  vi.stubGlobal("crypto", { getRandomValues });
  const project = createProject("LAN demo", { dialect: "postgresql" });
  const { project: imported } = importProjectValue(readProjectJson(JSON.stringify(project)));
  const ids = [project.id, imported.id, createLocalId()];
  expect(new Set(ids).size).toBe(3);

  for (const id of ids) {
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  }
});

it("should use native randomUUID when available", () => {
  const randomUUID = vi.fn(() => "native-id");
  vi.stubGlobal("crypto", { randomUUID });
  expect(createLocalId()).toBe("native-id");
  expect(randomUUID).toHaveBeenCalledOnce();
});
