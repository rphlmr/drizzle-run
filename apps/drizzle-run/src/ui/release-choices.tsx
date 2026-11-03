import { ChevronRightIcon } from "lucide-react";
import type { KeyboardEvent } from "react";

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../components/ui/collapsible";
import { RadioGroup, RadioGroupItem } from "../components/ui/radio-group";
import { ChoiceCard, choiceGridClass } from "./field";
import { getReleaseChoiceName, getReleaseLabel, type ReleaseOption, type ReleaseOptions } from "./release-options";
import { EffectBadge, NewestBadge, ReleasePair } from "./release-pair";

/**
 * The key of a pair and flavor by its versions, not its tuple id: ids include the database, and the
 * choice should survive switching between PostgreSQL and SQLite.
 */
export function toPairKey(option: Pick<ReleaseOption, "ormVersion" | "kitVersion" | "guestFlavor">) {
  const pairKey = `${option.ormVersion}__${option.kitVersion}`;

  return option.guestFlavor === "slim" ? pairKey : `${pairKey}+${option.guestFlavor}`;
}

export interface ReleaseChoicesProps {
  /** Id of the element that names the group. */
  labelId: string;
  options: Pick<ReleaseOptions, "lines" | "others">;
  selected: ReleaseOption | undefined;
  onSelect: (pairKey: string) => void;
  /** Key presses in the group, such as Enter on a choice to submit the form. */
  onKeyDown?: (event: KeyboardEvent<HTMLElement>) => void;
}

/** Radio cards for the newest pair of each line, with older pairs under "Other versions". */
export function ReleaseChoices({ labelId, options, selected, onSelect, onKeyDown }: ReleaseChoicesProps) {
  return (
    <RadioGroup
      aria-labelledby={labelId}
      onKeyDown={onKeyDown}
      className="flex flex-col gap-2.5"
      value={selected ? toPairKey(selected) : ""}
      onValueChange={(value) => {
        if (typeof value === "string") {
          onSelect(value);
        }
      }}
    >
      <div className={choiceGridClass}>
        {options.lines.map((option) => (
          <ReleaseChoice key={toPairKey(option)} option={option} checked={option === selected} />
        ))}
      </div>
      {options.others.length > 0 && (
        <Collapsible
          className="rounded-[12px] border border-border bg-surface"
          defaultOpen={selected !== undefined && options.others.includes(selected)}
        >
          <CollapsibleTrigger className="px-3 py-2.5">
            <ChevronRightIcon aria-hidden="true" />
            Other versions <span className="text-muted">{options.others.length}</span>
          </CollapsibleTrigger>
          <CollapsibleContent>
            {options.others.map((option) => (
              <label
                key={toPairKey(option)}
                className="flex min-h-touch cursor-pointer items-center gap-2.5 border-t border-surface-2 px-3 py-2.5 text-[13px] font-normal"
              >
                <RadioGroupItem value={toPairKey(option)} aria-label={getReleaseChoiceName(option)} />
                <span className="w-13 font-medium">{getReleaseLabel(option.ormVersion)}</span>
                <ReleasePair ormVersion={option.ormVersion} kitVersion={option.kitVersion} />
                {option.guestFlavor === "effect" && <EffectBadge className="ml-auto" />}
              </label>
            ))}
          </CollapsibleContent>
        </Collapsible>
      )}
    </RadioGroup>
  );
}

// Base UI radios are spans, which a wrapping <label> does not name. The card's
// spans would also read as one run-on word, so each radio gets a spoken name.
function ReleaseChoice({ option, checked }: { option: ReleaseOption; checked: boolean }) {
  return (
    <ChoiceCard checked={checked} className="flex-col items-stretch gap-1.5">
      <span className="flex items-center gap-2 font-semibold">
        <RadioGroupItem value={toPairKey(option)} aria-label={getReleaseChoiceName(option)} />
        {getReleaseLabel(option.ormVersion)}
        {option.badge && <NewestBadge className="ml-auto" />}
        {option.guestFlavor === "effect" && <EffectBadge className="ml-auto" />}
      </span>
      <ReleasePair ormVersion={option.ormVersion} kitVersion={option.kitVersion} />
    </ChoiceCard>
  );
}
