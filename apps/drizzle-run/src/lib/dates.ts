const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Today", "Oct 10", or "Oct 10, 2025" in local time; empty for an invalid time. */
export function formatShortDate(iso: string, now: Date = new Date()): string {
  const date = new Date(iso);

  if (!Number.isFinite(date.getTime())) {
    return "";
  }

  if (date.toDateString() === now.toDateString()) {
    return "Today";
  }

  const day = `${MONTHS[date.getMonth()]} ${date.getDate()}`;

  return date.getFullYear() === now.getFullYear() ? day : `${day}, ${date.getFullYear()}`;
}

/** "Oct 17, 2026" in local time; empty for an invalid time. */
export function formatLongDate(iso: string): string {
  const date = new Date(iso);

  if (!Number.isFinite(date.getTime())) {
    return "";
  }

  return `${MONTHS[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}`;
}
