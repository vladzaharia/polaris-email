// AddBridgeDialog — one-step "name the bridge" dialog. Everything that
// used to live in the post-registration modal (HMAC reveal, snippets,
// reachability check) now happens on the bridge's Detail page itself,
// driven by the absence of a heartbeat.
//
// Flow:
//   1. Operator opens the dialog, types a name, hits Register.
//   2. POST /v1/admin/bridges mints the bridge + returns the plaintext
//      HMAC key (read-once).
//   3. We stash the key in sessionStorage under
//      `polaris-bridge-fresh:<id>` so the Detail page can render it
//      inline once. The TTL is implicit: closing the tab drops it,
//      and the Detail page clears it as soon as the bridge phones
//      home (or as soon as the operator dismisses the banner).
//   4. We navigate to /bridges/$id?tab=connection so the operator
//      lands on the setup snippets with the key pre-filled.
import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { Plus } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '../../components/ui/dialog.js';
import { Button } from '../../components/ui/button.js';
import { Input } from '../../components/ui/input.js';
import { Label } from '../../components/ui/label.js';
import { ErrorText } from '../../components/ErrorText.js';
import { useAdminMutation } from '../../hooks/useAdminApi.js';
import { bridgeKeys } from '../../queryKeys.js';
import { stashFreshBridgeSecrets } from './freshBridgeKey.js';

export function AddBridgeDialog() {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');

  // Response carries `installer_url` (one-shot bash installer link,
  // 1h TTL). The TS auth key is NOT in this response — it flows
  // server-to-bridge via /v1/bridge/config + the bootstrap init
  // container, so operators never see it.
  const register = useAdminMutation<
    {
      id: string;
      hmac_key: string;
      installer_url: string | null;
    },
    { name: string }
  >((vars) => ({ path: '/api/admin/bridges', method: 'POST', body: vars }), {
    invalidateKeys: [bridgeKeys.all],
    silent: true,
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) {
          setName('');
          register.reset();
        }
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm">
          <Plus className="h-4 w-4" aria-hidden /> Add bridge
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Register on-prem bridge</DialogTitle>
          <DialogDescription>
            Mints a fresh HMAC key. Polaris stores only the hash; the next page is the only chance
            to copy the plaintext.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label htmlFor="bn">Bridge name</Label>
            <Input
              id="bn"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="acme-mx-1"
              autoComplete="off"
              spellCheck={false}
            />
            <p className="mt-1 text-xs text-[var(--color-muted-foreground)]">
              Lowercase, hyphenated. The operator chooses where this bridge runs.
            </p>
          </div>
          <ErrorText error={register.error} />
        </div>
        <DialogFooter>
          <Button
            size="sm"
            disabled={!name.trim() || register.isPending}
            onClick={async () => {
              const r = await register.mutateAsync({ name: name.trim() });
              stashFreshBridgeSecrets(r.id, {
                hmacKey: r.hmac_key,
                installerUrl: r.installer_url,
              });
              setOpen(false);
              setName('');
              void navigate({
                to: '/bridges/$id',
                params: { id: r.id },
                search: { tab: 'connection' },
              });
            }}
          >
            {register.isPending ? 'Registering…' : 'Register'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
