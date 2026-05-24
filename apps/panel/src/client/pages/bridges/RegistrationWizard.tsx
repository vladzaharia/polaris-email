// RegistrationWizard — replaces the old single-modal register flow with
// a three-step dialog: name → reveal+configure → reachability check.
//
// Step 3 polls `/api/admin/bridges/:id/heartbeat` every 3s and resolves
// when liveness flips to `live`. Timeout at 5 minutes (operators
// generally have to SSH to the bridge host and start it; 5 min is the
// happy upper bound). The bridge stays registered even if the dialog is
// closed early — operators can re-open the snippets from the bridge's
// Detail → Connection tab.
import { useEffect, useState } from 'react';
import { CheckCircle2, Loader2, Plus, AlertTriangle } from 'lucide-react';
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
import { useAdminMutation, useAdminQuery } from '../../hooks/useAdminApi.js';
import { bridgeKeys } from '../../queryKeys.js';
import { BridgeConnectionCard } from './BridgeConnectionCard.js';

type Step = 'name' | 'configure' | 'verify';

interface RegisteredBridge {
  id: string;
  name: string;
  hmacKey: string;
}

interface HeartbeatSnapshot {
  liveness: 'live' | 'stale' | 'offline';
  bridge_version: string | null;
  last_heartbeat_at: string | null;
}

// 5 minute window for the bridge to phone home. After that, surface the
// timeout state but leave the bridge registered.
const REACHABILITY_TIMEOUT_MS = 5 * 60 * 1000;
// Poll every 3s — fast enough to feel responsive, slow enough to avoid
// burning Worker invocations on a partition.
const REACHABILITY_POLL_MS = 3 * 1000;

export function RegistrationWizard() {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<Step>('name');
  const [name, setName] = useState('');
  const [registered, setRegistered] = useState<RegisteredBridge | null>(null);

  const register = useAdminMutation<{ id: string; hmac_key: string }, { name: string }>(
    (vars) => ({ path: '/api/admin/bridges', method: 'POST', body: vars }),
    { invalidateKeys: [bridgeKeys.all], silent: true },
  );

  const reset = () => {
    setStep('name');
    setName('');
    setRegistered(null);
    register.reset();
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm">
          <Plus className="h-4 w-4" aria-hidden /> Add bridge
        </Button>
      </DialogTrigger>
      <DialogContent className={step === 'configure' ? 'max-w-3xl' : undefined}>
        {step === 'name' ? (
          <>
            <DialogHeader>
              <DialogTitle>Register on-prem bridge</DialogTitle>
              <DialogDescription>
                Mints a fresh HMAC key for this bridge. Polaris stores only the hash — the next step
                is the only chance to copy the key.
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
                  setRegistered({ id: r.id, name: name.trim(), hmacKey: r.hmac_key });
                  setStep('configure');
                }}
              >
                {register.isPending ? 'Registering…' : 'Continue'}
              </Button>
            </DialogFooter>
          </>
        ) : null}

        {step === 'configure' && registered ? (
          <>
            <DialogHeader>
              <DialogTitle>Bridge {registered.name} registered</DialogTitle>
              <DialogDescription>
                Copy a snippet below and start the bridge on its host. Once it phones home, the next
                step will turn green automatically.
              </DialogDescription>
            </DialogHeader>
            {/* showRotate=false: the bridge has never connected yet, so
                rotating before the first deploy just throws away the key
                we just minted. */}
            <BridgeConnectionCard
              bridgeId={registered.id}
              bridgeName={registered.name}
              initialHmacKey={registered.hmacKey}
              showRotate={false}
            />
            <DialogFooter>
              <Button size="sm" variant="outline" onClick={() => setOpen(false)}>
                Finish later
              </Button>
              <Button size="sm" onClick={() => setStep('verify')}>
                Wait for bridge
              </Button>
            </DialogFooter>
          </>
        ) : null}

        {step === 'verify' && registered ? (
          <ReachabilityCheck
            bridge={registered}
            onClose={() => setOpen(false)}
            onBack={() => setStep('configure')}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function ReachabilityCheck({
  bridge,
  onClose,
  onBack,
}: {
  bridge: RegisteredBridge;
  onClose: () => void;
  onBack: () => void;
}) {
  const [startedAt] = useState(() => Date.now());
  const [timedOut, setTimedOut] = useState(false);

  const q = useAdminQuery<HeartbeatSnapshot>(
    bridgeKeys.heartbeat(bridge.id),
    `/api/admin/bridges/${bridge.id}/heartbeat`,
    { refetchInterval: timedOut ? undefined : REACHABILITY_POLL_MS },
  );

  // Trip the timeout flag after the window elapses. We don't unmount —
  // the bridge is still registered and the user might want to copy a
  // troubleshooting snippet from the previous step.
  useEffect(() => {
    if (timedOut || q.data?.liveness === 'live') return;
    const remaining = startedAt + REACHABILITY_TIMEOUT_MS - Date.now();
    if (remaining <= 0) {
      setTimedOut(true);
      return;
    }
    const t = setTimeout(() => setTimedOut(true), remaining);
    return () => clearTimeout(t);
  }, [startedAt, timedOut, q.data?.liveness]);

  const live = q.data?.liveness === 'live';
  return (
    <>
      <DialogHeader>
        <DialogTitle>Waiting for bridge {bridge.name}</DialogTitle>
        <DialogDescription>
          The first heartbeat lands within ~60 seconds of the bridge starting. We poll every 3
          seconds.
        </DialogDescription>
      </DialogHeader>
      <div className="space-y-4">
        {live ? (
          <div
            className="flex items-start gap-3 rounded-md border border-[var(--color-border)] p-4"
            style={{
              background: 'color-mix(in oklch, var(--color-card) 88%, var(--color-success) 12%)',
            }}
          >
            <CheckCircle2 className="h-5 w-5 text-[var(--color-success)]" aria-hidden />
            <div>
              <div className="font-semibold">Bridge connected</div>
              <div className="mt-0.5 text-xs text-[var(--color-muted-foreground)]">
                mail-bridge {q.data?.bridge_version ?? '(version unknown)'}, last heartbeat{' '}
                {q.data?.last_heartbeat_at
                  ? new Date(q.data.last_heartbeat_at).toLocaleString()
                  : '—'}
                .
              </div>
            </div>
          </div>
        ) : timedOut ? (
          <div
            className="flex items-start gap-3 rounded-md border border-[var(--color-border)] p-4"
            style={{
              background: 'color-mix(in oklch, var(--color-card) 88%, var(--color-warning) 12%)',
            }}
          >
            <AlertTriangle className="h-5 w-5 text-[var(--color-warning)]" aria-hidden />
            <div className="space-y-1 text-sm">
              <div className="font-semibold">No heartbeat received</div>
              <p className="text-xs text-[var(--color-muted-foreground)]">
                The bridge hasn't checked in within five minutes. Common causes:
              </p>
              <ul className="list-disc pl-5 text-xs text-[var(--color-muted-foreground)]">
                <li>
                  Container failed to start — check{' '}
                  <span className="font-mono">docker logs polaris-mail-bridge</span>.
                </li>
                <li>POLARIS_API_HOSTNAME unreachable from the bridge host (firewall, DNS).</li>
                <li>HMAC key not pasted into the env / compose file.</li>
              </ul>
              <p className="text-xs text-[var(--color-muted-foreground)]">
                The bridge stays registered — once it phones home, it'll show up on the bridges
                list. You can also re-open the snippets later from the bridge's Detail page.
              </p>
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-3 rounded-md border border-[var(--color-border)] p-4">
            <Loader2 className="h-5 w-5 animate-spin text-[var(--color-muted-foreground)]" />
            <div className="text-sm">
              Polling for the first heartbeat… start the bridge on its host now.
            </div>
          </div>
        )}
      </div>
      <DialogFooter>
        {live ? (
          <Button size="sm" onClick={onClose}>
            Done
          </Button>
        ) : (
          <>
            <Button size="sm" variant="outline" onClick={onBack}>
              Back to snippets
            </Button>
            <Button size="sm" variant="outline" onClick={onClose}>
              Finish anyway
            </Button>
          </>
        )}
      </DialogFooter>
    </>
  );
}
