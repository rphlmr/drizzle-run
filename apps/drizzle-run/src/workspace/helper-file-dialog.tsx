import { PROJECT_FILE_EXTENSIONS } from "@drizzle-run/core/manifest";
import { useActorRef, useSelector } from "@xstate/react";

import { Button } from "../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { getErrorText } from "../lib/error-text";
import { getHelperFileAction, helperFileDialogMachine, type HelperFileAction } from "./helper-file-dialog-machine";

/** A submitted helper file change: `path` is the file it acts on, `filename` the path typed in the dialog. */
export interface HelperFileRequest {
  action: HelperFileAction;
  path: string;
  filename: string;
}

/** Options of `useHelperFileDialog`. */
export interface UseHelperFileDialogOptions {
  /** One side or two: a side-by-side project's files belong to both sides, and the dialog says so. */
  sides: 1 | 2;
  /** The open file, which Rename and Delete act on. */
  selected: string;
  /** Applies the change; a throw keeps the dialog open with its message under the field. */
  onSubmit: (request: HelperFileRequest) => void;
}

const deleteNotes = {
  1: (path: string) => `Remove ${path}? Existing imports may need updating.`,
  2: (path: string) => `Remove ${path} from both sides? Existing imports may need updating.`,
} as const;

// The path check matches these extensions in lowercase only.
const pathRule = `Use a relative path ending in ${new Intl.ListFormat("en", { type: "disjunction" }).format(PROJECT_FILE_EXTENSIONS)}, in lowercase.`;

const pathNotes: Record<"create" | "rename", Record<1 | 2, string>> = {
  create: {
    1: pathRule,
    2: `${pathRule} A new file is shared by both sides.`,
  },
  rename: {
    1: `${pathRule} Renaming does not rewrite imports.`,
    2: `${pathRule} Renaming does not rewrite imports.`,
  },
};

const titles: Record<HelperFileAction, string> = {
  create: "New helper file",
  rename: "Rename helper file",
  delete: "Delete helper file?",
};

/**
 * The helper file dialog of a project view
 *
 * Returns the openers for "+" and the file menu, and the dialog to render once in the view.
 */
export function useHelperFileDialog({ sides, selected, onSubmit }: UseHelperFileDialogOptions) {
  const dialog = useActorRef(helperFileDialogMachine);
  const action = useSelector(dialog, getHelperFileAction);
  const filename = useSelector(dialog, (snapshot) => snapshot.context.filename);
  const error = useSelector(dialog, (snapshot) => snapshot.context.error);
  const close = () => dialog.send({ type: "dialog.close" });

  const helperFileDialog = (
    <Dialog
      open={action !== null}
      onOpenChange={(open) => {
        if (!open) {
          close();
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{titles[action ?? "create"]}</DialogTitle>
          <DialogDescription>
            {action === "delete" ? deleteNotes[sides](selected) : pathNotes[action ?? "create"][sides]}
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault();

            if (!action) {
              return;
            }

            try {
              onSubmit({ action, path: action === "create" ? filename : selected, filename });
              close();
            } catch (cause) {
              dialog.send({ type: "submit.fail", error: getErrorText(cause) });
            }
          }}
        >
          {action !== "delete" && (
            <label>
              File path
              <Input
                value={filename}
                onChange={(event) => dialog.send({ type: "filename.change", filename: event.target.value })}
                required
              />
            </label>
          )}
          {error && <p role="alert">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" variant={action === "delete" ? "destructive" : "default"}>
              {action === "delete" ? "Delete file" : "Save file"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );

  return {
    openCreate: () => dialog.send({ type: "create.open" }),
    openRename: () => dialog.send({ type: "rename.open", path: selected }),
    openDelete: () => dialog.send({ type: "delete.open" }),
    helperFileDialog,
  };
}
