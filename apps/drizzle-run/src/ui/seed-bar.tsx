import { Switch } from "../components/ui/switch";

/**
 * The seed file's switch, above its code
 *
 * Says whether runs execute this file first, so the seed's state sits with the seed instead of in a menu.
 */
export function SeedBar({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  return (
    <div
      className="flex flex-none flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-4 py-2 text-[13px] max-phone:px-3"
      data-seed={on ? "on" : "off"}
    >
      <label className="flex items-center gap-2 font-[550] max-phone:min-h-touch">
        <Switch checked={on} onCheckedChange={onToggle} />
        Seed on each run
      </label>
      <span className="text-muted">
        {on
          ? "Each run fills a fresh database with this file first."
          : "Off: runs skip this file and start with empty tables."}
      </span>
    </div>
  );
}
