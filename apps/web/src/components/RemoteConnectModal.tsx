/**
 * RemoteConnectModal - Quick-access modal for configuring the remote host.
 *
 * Wraps RemoteHostSettingsForm in a Dialog so the user can connect/disconnect
 * without leaving the current view.
 *
 * @module RemoteConnectModal
 */
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
} from "./ui/dialog";
import { RemoteHostSettingsForm } from "./RemoteHostSettingsForm";

interface RemoteConnectModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function RemoteConnectModal({ open, onOpenChange }: RemoteConnectModalProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Remote Connect</DialogTitle>
          <DialogDescription>
            Connect to a self-hosted T3 server on a remote machine via SSH tunnel. The app switches
            automatically after a successful sync.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <RemoteHostSettingsForm />
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
