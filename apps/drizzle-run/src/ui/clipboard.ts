import { useEffect, useState } from "react";

/** How a copy ended; a refused or missing clipboard is "failed", never a thrown error. */
export type CopyOutcome = "copied" | "failed";

/** Never rejects: a refused permission or a missing clipboard (insecure context) is "failed". */
export async function copyText(
  text: string,
  clipboard: Pick<Clipboard, "writeText"> | undefined,
): Promise<CopyOutcome> {
  if (clipboard === undefined) {
    return "failed";
  }

  try {
    await clipboard.writeText(text);

    return "copied";
  } catch {
    return "failed";
  }
}

/** Copies text and keeps the outcome long enough to show it, then clears it. */
export function useCopyFeedback(resetMs = 2000): { outcome: CopyOutcome | undefined; copy: (text: string) => void } {
  const [outcome, setOutcome] = useState<CopyOutcome>();

  useEffect(() => {
    if (outcome === undefined) {
      return;
    }

    const timer = setTimeout(() => setOutcome(undefined), resetMs);

    return () => clearTimeout(timer);
  }, [outcome, resetMs]);

  return {
    outcome,
    copy(text) {
      // Older Safari and insecure contexts have no navigator.clipboard at all.
      const clipboard: Pick<Clipboard, "writeText"> | undefined =
        "clipboard" in navigator ? navigator.clipboard : undefined;

      void copyText(text, clipboard).then(setOutcome);
    },
  };
}
