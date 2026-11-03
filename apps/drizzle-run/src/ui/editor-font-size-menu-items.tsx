import {
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from "../components/ui/dropdown-menu";
import { applyEditorFontSize, EDITOR_FONT_SIZES } from "../design/editor-font-size";
import { useEditorFontSize } from "./use-editor-font-size";

const DEFAULT_VALUE = "default";

/**
 * Code size choices of a menu
 *
 * Default keeps the layout's own size, shown as `defaultFontSize`; a picked size applies to every editor on the page
 * and is saved for the next visit. A size equal to the default is not listed twice: Default stands for it.
 */
export function EditorFontSizeMenuItems({ defaultFontSize }: { defaultFontSize: number }) {
  const size = useEditorFontSize();
  const otherSizes = EDITOR_FONT_SIZES.filter((option) => option !== defaultFontSize);

  return (
    <DropdownMenuGroup>
      <DropdownMenuLabel>Code size</DropdownMenuLabel>
      <DropdownMenuRadioGroup
        value={size === null || size === defaultFontSize ? DEFAULT_VALUE : String(size)}
        onValueChange={(value) => {
          applyEditorFontSize(EDITOR_FONT_SIZES.find((option) => String(option) === value) ?? null);
        }}
      >
        <DropdownMenuRadioItem value={DEFAULT_VALUE} closeOnClick>
          Default
          <span className="ml-auto pl-3 text-[12px] text-muted">{defaultFontSize} px</span>
        </DropdownMenuRadioItem>
        {otherSizes.map((option) => (
          <DropdownMenuRadioItem key={option} value={String(option)} closeOnClick>
            {option} px
          </DropdownMenuRadioItem>
        ))}
      </DropdownMenuRadioGroup>
    </DropdownMenuGroup>
  );
}
