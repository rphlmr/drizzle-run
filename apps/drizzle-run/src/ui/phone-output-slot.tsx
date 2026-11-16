import { createContext, useContext, useState, type ReactNode } from "react";

const SlotContext = createContext<{ element: HTMLElement | null; setElement: (element: HTMLElement | null) => void }>({
  element: null,
  setElement: () => undefined,
});

/**
 * Phones: the place at the end of the workspace's view switch where the output draws its run status
 *
 * The output keeps the status, as on desktop where it ends its own bar, and renders it into this slot with a portal, so
 * the status shows from every view. An output without its own tabs draws its history and settings there too.
 */
export function PhoneOutputSlotProvider({ children }: { children: ReactNode }) {
  const [element, setElement] = useState<HTMLElement | null>(null);

  return <SlotContext value={{ element, setElement }}>{children}</SlotContext>;
}

/** Keeps an output out of the slot, such as the side a phone does not show. */
export function PhoneOutputSlotOff({ children }: { children: ReactNode }) {
  return <SlotContext value={{ element: null, setElement: () => undefined }}>{children}</SlotContext>;
}

/** The slot itself, at the end of a tab row. */
export function PhoneOutputSlot() {
  const { setElement } = useContext(SlotContext);

  return <div ref={setElement} className="flex shrink-0 items-center gap-1 empty:hidden" data-slot="output-tools" />;
}

/** The slot's element, or null outside a phone workspace. */
export function usePhoneOutputSlot(): HTMLElement | null {
  return useContext(SlotContext).element;
}
