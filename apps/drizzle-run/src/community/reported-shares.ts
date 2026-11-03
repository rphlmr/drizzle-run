import * as z from "zod/mini";

/** Shares this browser already reported, so their cards say so after a reload. */
export interface ReportedShares {
  has(id: string): boolean;
  add(id: string): void;
}

const reportedKey = "drizzle-run:community-reported";

const ReportedIdsSchema = z.catch(z.array(z.string()), []);

/** The IDs kept in localStorage; throws when storage is blocked or holds text that is not JSON. */
function readReportedIds() {
  const value: unknown = JSON.parse(window.localStorage.getItem(reportedKey) ?? "[]");

  return ReportedIdsSchema.parse(value);
}

/** Kept in localStorage: a per-browser convenience, never needed for a report to count. */
export const localReportedShares: ReportedShares = {
  has(id) {
    try {
      return readReportedIds().includes(id);
    } catch {
      return false;
    }
  },
  add(id) {
    try {
      const ids = readReportedIds();
      window.localStorage.setItem(reportedKey, JSON.stringify([...ids.filter((item) => item !== id), id].slice(-200)));
    } catch {
      // Storage may be blocked; the report itself was still sent.
    }
  },
};
