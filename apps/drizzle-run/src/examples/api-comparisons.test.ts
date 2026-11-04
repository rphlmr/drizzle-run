import { serializeValue } from "@drizzle-run/core/contracts";
import { describe, expect, it } from "vitest";

import { listOfficialEmbeds } from "../official/official-embeds";
import { loadOfficialRecording } from "../official/official-recordings";
import { listExamples } from "./catalog";

const embeds = listOfficialEmbeds(listExamples());

async function getSqlDisplays(example: string, step?: string) {
  const embed = embeds.find((candidate) => candidate.example.slug === example && candidate.step?.id === step);

  if (!embed) {
    throw new Error(`Missing comparison embed: ${example}/${step ?? "example"}`);
  }

  const recording = await loadOfficialRecording(embed);

  if (!recording?.sides) {
    throw new Error(`Missing current two-side recording: ${embed.recordingPath}`);
  }

  return Object.fromEntries(recording.sides[0].displays.map(({ label, values }) => [label, values]));
}

describe("SQL-like and RQB comparison results", () => {
  it.each(["postgresql", "sqlite"])("should return identical displays through both APIs on %s", async (dialect) => {
    const comparisons = embeds.filter(({ example }) =>
      [`pagination-apis-${dialect}`, `helper-apis-${dialect}`].includes(example.slug),
    );

    expect(comparisons).toHaveLength(8);

    for (const embed of comparisons) {
      const recording = await loadOfficialRecording(embed);

      if (!recording?.sides) {
        throw new Error(`Missing current two-side recording: ${embed.recordingPath}`);
      }

      const [sql, rqb] = recording.sides.map((result) =>
        Object.fromEntries(result.displays.map(({ label, values }) => [label, values])),
      );

      expect(rqb, embed.recordingPath).toEqual(sql);
    }
  });

  it.each(["postgresql", "sqlite"])(
    "should demonstrate offset shifts and preserve cursor ties on %s",
    async (dialect) => {
      const shifted = await getSqlDisplays(`pagination-apis-${dialect}`, "02-shift");
      const naive = await getSqlDisplays(`pagination-apis-${dialect}`, "03-ties");
      const cursor = await getSqlDisplays(`pagination-apis-${dialect}`, "04-composite");

      expect(shifted["Offset page after insert"]).toMatchObject([serializeValue([{ id: 2 }, { id: 3 }])]);
      expect(naive["Timestamp-only cursor skips a tie"]).toMatchObject([serializeValue([{ id: 4 }, { id: 5 }])]);

      for (const page of [1, 2, 3]) {
        expect(cursor[`Cursor page ${page}`]).toMatchObject([
          serializeValue({
            items: [{ id: page * 2 - 1 }, { id: page * 2 }],
            hasNextPage: page < 3,
          }),
        ]);
      }

      expect(cursor["Cursor page 3"]).toMatchObject([serializeValue({ nextCursor: null })]);
    },
  );

  it.each(["postgresql", "sqlite"])("should preserve null text and boolean profile values on %s", async (dialect) => {
    const displays = await getSqlDisplays(`helper-apis-${dialect}`, "02-authors");

    expect(displays.Profiles).toEqual([
      serializeValue([
        { profile: { id: 1, displayName: "Ada", bio: "Writes about SQL", active: true } },
        { profile: { id: 2, displayName: "Grace", bio: null, active: false } },
      ]),
    ]);
  });
});
