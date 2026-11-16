import type { RunManifestTarget } from "@drizzle-run/core/manifest";
import { ChevronDownIcon } from "lucide-react";

import { Button } from "../components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu";
import { DialectLogo } from "./dialect-logo";
import { phoneSheetClass, phoneSheetProps } from "./phone-sheet";

type Dialect = RunManifestTarget["dialect"];

const SHORT_LABELS: Record<Dialect, string> = { postgresql: "PG", sqlite: "SQLite" };

export interface DialectMenuProps<T extends Dialect> {
  label: string;
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
}

/**
 * Phones: a database picker as one compact button beside a search field, with the choices in a bottom sheet
 *
 * Desktop shows the same choice as a segmented control.
 */
export function DialectMenu<T extends Dialect>({ label, options, value, onChange }: DialectMenuProps<T>) {
  const current = options.find((option) => option.value === value);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="outline"
            className="h-touch shrink-0 gap-1.5 rounded-md px-2.5"
            aria-label={`${label}: ${current?.label ?? value}`}
          />
        }
      >
        <DialectLogo dialect={value} className="size-4" />
        {SHORT_LABELS[value]}
        <ChevronDownIcon className="size-3.5 text-muted" aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent {...phoneSheetProps} className={phoneSheetClass}>
        <span aria-hidden="true" className="mx-auto mb-2 block h-1 w-9 rounded-pill bg-card-border" />
        <DropdownMenuGroup>
          <DropdownMenuLabel>{label}</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={value}
            onValueChange={(next) => {
              const picked = options.find((option) => option.value === next);
              if (picked) {
                onChange(picked.value);
              }
            }}
          >
            {options.map((option) => (
              <DropdownMenuRadioItem key={option.value} value={option.value} className="min-h-11 gap-2.5">
                <DialectLogo dialect={option.value} className="size-4" />
                {option.label}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
