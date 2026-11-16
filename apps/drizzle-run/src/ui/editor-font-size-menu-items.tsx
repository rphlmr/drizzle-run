import {
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from "../components/ui/dropdown-menu";
import { applyEditorFontSize, EDITOR_FONT_SIZES } from "../design/editor-font-size";
import { cn } from "../lib/utils";
import { menuSegmentClass, menuSegmentsClass } from "./menu-segments";
import { useEditorFontSize } from "./use-editor-font-size";

const DEFAULT_VALUE = "default";

/**
 * Code size choices of a menu
 *
 * Default keeps the layout's own size, shown as `defaultFontSize`; a picked size applies to every editor on the page
 * and is saved for the next visit. A size equal to the default is not listed twice: Default stands for it.
 * `segmented` draws the choices as one row.
 */
export function EditorFontSizeMenuItems({
  defaultFontSize,
  segmented = false,
}: {
  defaultFontSize: number;
  segmented?: boolean;
}) {
  const size = useEditorFontSize();
  const otherSizes = EDITOR_FONT_SIZES.filter((option) => option !== defaultFontSize);

  return (
    <DropdownMenuGroup>
      <DropdownMenuLabel>Code size</DropdownMenuLabel>
      <DropdownMenuRadioGroup
        className={cn(segmented && menuSegmentsClass)}
        value={size === null || size === defaultFontSize ? DEFAULT_VALUE : String(size)}
        onValueChange={(value) => {
          applyEditorFontSize(EDITOR_FONT_SIZES.find((option) => String(option) === value) ?? null);
        }}
      >
        <DropdownMenuRadioItem
          value={DEFAULT_VALUE}
          closeOnClick={!segmented}
          className={cn(segmented && menuSegmentClass)}
        >
          Default
          {!segmented && <span className="ml-auto pl-3 text-[12px] text-muted">{defaultFontSize} px</span>}
        </DropdownMenuRadioItem>
        {otherSizes.map((option) => (
          <DropdownMenuRadioItem
            key={option}
            value={String(option)}
            closeOnClick={!segmented}
            className={cn(segmented && menuSegmentClass)}
          >
            {option} px
          </DropdownMenuRadioItem>
        ))}
      </DropdownMenuRadioGroup>
    </DropdownMenuGroup>
  );
}
