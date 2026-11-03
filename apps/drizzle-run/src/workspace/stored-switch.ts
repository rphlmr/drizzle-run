/** Where a switch keeps its choice: the key, and the value stored while it is off. */
export interface StoredSwitchOptions {
  key: string;
  offValue: string;
}

/**
 * Create a switch kept in localStorage that is on until turned off
 *
 * Only "off" is stored; turning it on removes the value, so the default applies again. Anything but the stored off
 * value, including a throwing or missing storage, reads as on.
 */
export function createStoredSwitch({ key, offValue }: StoredSwitchOptions) {
  const changeEvent = `drizzle-run:${key}`;

  const read = (storage: Pick<Storage, "getItem"> | null): boolean => {
    try {
      return storage?.getItem(key) !== offValue;
    } catch {
      return true;
    }
  };

  const write = (storage: Pick<Storage, "setItem" | "removeItem"> | null, on: boolean): void => {
    try {
      if (on) {
        storage?.removeItem(key);
      } else {
        storage?.setItem(key, offValue);
      }
    } catch {
      // Storage can be full or blocked; the choice still applies for this page.
    }
  };

  return {
    read,
    write,
    /** Reads this page's choice. */
    readCurrent: () => read(getSafeStorage()),
    /** Saves the choice and tells everything on the page that reads it. */
    apply: (on: boolean) => {
      write(getSafeStorage(), on);
      window.dispatchEvent(new Event(changeEvent));
    },
    /** Calls `onChange` when this page or another tab changes the choice; for `useSyncExternalStore`. */
    subscribe: (onChange: () => void) => {
      const onStorage = (event: StorageEvent) => {
        // A null key is a `clear()`, which turns the switch back on.
        if (event.key === key || event.key === null) {
          onChange();
        }
      };

      window.addEventListener(changeEvent, onChange);
      window.addEventListener("storage", onStorage);

      return () => {
        window.removeEventListener(changeEvent, onChange);
        window.removeEventListener("storage", onStorage);
      };
    },
  };
}

function getSafeStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
