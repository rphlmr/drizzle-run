// index.html repeats readPreference and resolveTheme inline so the theme is set before first paint.
/** The theme the user picked; "system" follows the OS setting. */
export type ThemePreference = "light" | "dark" | "system";

const PREFERENCES: readonly ThemePreference[] = ["light", "dark", "system"];
const STORAGE_KEY = "theme";
const DARK_QUERY = "(prefers-color-scheme: dark)";

/** Stored preference; a missing or unknown value, or a throwing storage, means system. */
export function readPreference(storage: Pick<Storage, "getItem"> | null): ThemePreference {
  try {
    const value = storage?.getItem(STORAGE_KEY);

    return PREFERENCES.find((preference) => preference === value) ?? "system";
  } catch {
    return "system";
  }
}

/** Resolves a preference to the theme to paint, following the OS for "system". */
export function resolveTheme(preference: ThemePreference, prefersDark: boolean): "light" | "dark" {
  if (preference === "system") {
    return prefersDark ? "dark" : "light";
  }

  return preference;
}

function getSafeStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * Read the theme an embed's host picked
 *
 * An embed frame opens at `/embed/...?theme=light` or `?theme=dark` when the host page passes a theme. Any other page,
 * or a missing or unknown value, reads as `null`.
 */
export function readEmbedTheme(location: Pick<Location, "pathname" | "search">): "light" | "dark" | null {
  if (!location.pathname.startsWith("/embed/")) {
    return null;
  }

  const theme = new URLSearchParams(location.search).get("theme");

  return theme === "light" || theme === "dark" ? theme : null;
}

/** Reads the embed host's theme, else the stored preference; private windows that block storage read as "system". */
export function readCurrentPreference(): ThemePreference {
  return readEmbedTheme(window.location) ?? readPreference(getSafeStorage());
}

function paintTheme(preference: ThemePreference): void {
  const theme = resolveTheme(preference, window.matchMedia(DARK_QUERY).matches);
  const root = document.documentElement;

  root.dataset.theme = theme;
  root.style.colorScheme = theme;
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", getComputedStyle(root).getPropertyValue("--bg").trim());
}

/** Saves the preference and applies it to `<html>` (`data-theme`, `color-scheme`, `theme-color`). */
export function applyTheme(preference: ThemePreference): void {
  try {
    getSafeStorage()?.setItem(STORAGE_KEY, preference);
  } catch {
    // Storage can be full or blocked; the theme still applies for this page.
  }

  paintTheme(preference);
}

const repaintSystemTheme = () => {
  if (readCurrentPreference() === "system") {
    paintTheme("system");
  }
};

/** Repaints when the OS theme changes while the preference is system. */
export function followSystemTheme(): () => void {
  const media = window.matchMedia(DARK_QUERY);

  media.addEventListener("change", repaintSystemTheme);

  return () => media.removeEventListener("change", repaintSystemTheme);
}
