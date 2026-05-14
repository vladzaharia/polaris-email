// StepUpModal — opened when api.ts throws StepUpRequiredError. Phase I wires
// up the actual WebAuthn / re-auth flow; for now it's a placeholder that
// records the step-up via POST /api/step-up.
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from './ui/dialog.js';
import { Button } from './ui/button.js';
import { apiFetch } from '../lib/api.js';

export function StepUpModal({
  open,
  onClose,
  reason,
}: {
  open: boolean;
  onClose: (ok: boolean) => void;
  reason?: string;
}) {
  return (
    <Dialog open={open} onOpenChange={(o) => (o ? null : onClose(false))}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Re-authenticate to continue</DialogTitle>
          <DialogDescription>
            This action requires a fresh sign-in. {reason ? `Reason: ${reason}.` : ''}
          </DialogDescription>
        </DialogHeader>
        <Button
          onClick={async () => {
            await apiFetch('/api/step-up', { method: 'POST', body: JSON.stringify({ reason }) });
            onClose(true);
          }}
        >
          Confirm
        </Button>
      </DialogContent>
    </Dialog>
  );
}
