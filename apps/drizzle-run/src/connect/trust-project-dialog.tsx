import { Button } from "../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";

/**
 * Trust confirmation
 *
 * The one way a project of someone else's gets full AI: the user confirms here, after pressing Allow AI edits in
 * the chat note or the project menu.
 */
export function TrustProjectDialog({
  open,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Allow AI edits?</DialogTitle>
          <DialogDescription>Someone else wrote this code. Be careful: read it first.</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" type="button" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" onClick={onConfirm}>
            Allow AI edits
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
