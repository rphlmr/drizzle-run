import { useState } from "react";

import {
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from "../components/ui/dropdown-menu";
import { applyTheme, readCurrentPreference, type ThemePreference } from "../design/theme";

const options: { value: ThemePreference; label: string }[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

/** The Light, Dark and System choices of a menu, saved and applied on pick. */
export function ThemeMenuItems() {
  const [preference, setPreference] = useState(readCurrentPreference);

  return (
    <DropdownMenuGroup>
      <DropdownMenuLabel>Theme</DropdownMenuLabel>
      <DropdownMenuRadioGroup
        value={preference}
        onValueChange={(value) => {
          const next = options.find((option) => option.value === value)?.value;

          if (next !== undefined) {
            applyTheme(next);
            setPreference(next);
          }
        }}
      >
        {options.map((option) => (
          <DropdownMenuRadioItem key={option.value} value={option.value} closeOnClick>
            {option.label}
          </DropdownMenuRadioItem>
        ))}
      </DropdownMenuRadioGroup>
    </DropdownMenuGroup>
  );
}
