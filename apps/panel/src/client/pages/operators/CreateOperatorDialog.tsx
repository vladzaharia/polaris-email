// Mint a new operator + their pk_op_ api_key. The full login token
// (`polaris_{kid}.{secret}`) is shown ONCE in a read-once reveal dialog;
// Polaris stores only the hashed secret afterward.
//
// The SSH fingerprint is computed client-side from the pasted authorized_keys
// line via Web Crypto: SHA-256 over the base64-decoded binary key data,
// re-encoded as `SHA256:<base64-no-padding>`. Matches `ssh-keygen -lf -`.
import { useEffect, useState } from 'react';
import { Plus } from 'lucide-react';
import { Button } from '../../components/ui/button.js';
import { Input } from '../../components/ui/input.js';
import { Label } from '../../components/ui/label.js';
import { Checkbox } from '../../components/ui/checkbox.js';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '../../components/ui/dialog.js';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../components/ui/select.js';
import { SecretRevealDialog } from '../../components/SecretRevealDialog.js';
import { ErrorText } from '../../components/ErrorText.js';
import { useAdminMutation } from '../../hooks/useAdminApi.js';
import { operatorKeys } from '../../queryKeys.js';

type Role = 'admin' | 'operator' | 'readonly';

const ROLE_DEFAULTS: Record<Role, string[]> = {
  admin: ['admin:read', 'admin:rotate', 'admin:impersonate'],
  operator: ['admin:read', 'admin:rotate'],
  readonly: ['admin:read'],
};

const ALL_SCOPES = [
  'admin:read',
  'admin:rotate',
  'admin:impersonate',
  'send',
  'messages:read',
  'imap_bridge:read',
] as const;

const PUBKEY_RE =
  /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp256|ecdsa-sha2-nistp384|ecdsa-sha2-nistp521)\s/;

async function computeFingerprint(pubkey: string): Promise<string> {
  const parts = pubkey.trim().split(/\s+/);
  if (parts.length < 2) throw new Error('pubkey must be a single authorized_keys line');
  const keyData = parts[1] ?? '';
  if (!keyData) throw new Error('pubkey missing key data');
  const binary = Uint8Array.from(atob(keyData), (c) => c.charCodeAt(0));
  const hash = await crypto.subtle.digest('SHA-256', binary);
  let bin = '';
  for (const b of new Uint8Array(hash)) bin += String.fromCharCode(b);
  return `SHA256:${btoa(bin).replace(/=+$/, '')}`;
}

interface CreateOperatorRequest {
  name: string;
  email: string;
  ssh_pubkey: string;
  ssh_pubkey_fp_sha256: string;
  role: Role;
  scopes: string[];
  rate_limit_per_min: number;
}

interface CreateOperatorResponse {
  operator: { id: string; name: string };
  login_token: string;
}

export function CreateOperatorDialog() {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [pubkey, setPubkey] = useState('');
  const [fingerprint, setFingerprint] = useState('');
  const [fingerprintError, setFingerprintError] = useState<string | null>(null);
  const [role, setRole] = useState<Role>('operator');
  const [scopes, setScopes] = useState<string[]>(ROLE_DEFAULTS.operator);
  const [scopesEdited, setScopesEdited] = useState(false);
  const [loginToken, setLoginToken] = useState<string | null>(null);

  // Re-derive fingerprint whenever pubkey changes.
  useEffect(() => {
    const trimmed = pubkey.trim();
    if (!trimmed) {
      setFingerprint('');
      setFingerprintError(null);
      return;
    }
    if (!PUBKEY_RE.test(trimmed)) {
      setFingerprint('');
      setFingerprintError('must start with ssh-ed25519, ssh-rsa, or ecdsa-sha2-nistp*');
      return;
    }
    computeFingerprint(trimmed)
      .then((fp) => {
        setFingerprint(fp);
        setFingerprintError(null);
      })
      .catch((e: unknown) => {
        setFingerprint('');
        setFingerprintError(e instanceof Error ? e.message : 'fingerprint computation failed');
      });
  }, [pubkey]);

  // Apply role-based scope preset unless the operator has manually edited.
  useEffect(() => {
    if (!scopesEdited) setScopes(ROLE_DEFAULTS[role]);
  }, [role, scopesEdited]);

  const create = useAdminMutation<CreateOperatorResponse, CreateOperatorRequest>(
    (vars) => ({ path: '/api/admin/operators', method: 'POST', body: vars }),
    {
      invalidateKeys: [operatorKeys.all],
      silent: true,
    },
  );

  function reset() {
    setName('');
    setEmail('');
    setPubkey('');
    setFingerprint('');
    setFingerprintError(null);
    setRole('operator');
    setScopes(ROLE_DEFAULTS.operator);
    setScopesEdited(false);
    create.reset();
  }

  const canSubmit =
    !create.isPending &&
    name.trim().length > 0 &&
    email.trim().length > 0 &&
    pubkey.trim().length > 0 &&
    fingerprint.length > 0 &&
    scopes.length > 0;

  async function handleSubmit() {
    const r = await create.mutateAsync({
      name: name.trim(),
      email: email.trim(),
      ssh_pubkey: pubkey.trim(),
      ssh_pubkey_fp_sha256: fingerprint,
      role,
      scopes,
      rate_limit_per_min: 600,
    });
    setLoginToken(r.login_token);
    setOpen(false);
  }

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          if (!o) reset();
        }}
      >
        <DialogTrigger asChild>
          <Button size="sm">
            <Plus className="h-4 w-4" /> Add operator
          </Button>
        </DialogTrigger>
        <DialogContent className="max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Add operator</DialogTitle>
            <DialogDescription>
              Mints an operator + a `pk_op_` CLI/admin API token. The login token is shown once;
              Polaris stores only its hash.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label htmlFor="op-name">Name</Label>
              <Input
                id="op-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Alice"
                autoComplete="off"
                spellCheck={false}
                className="mt-1"
              />
            </div>
            <div>
              <Label htmlFor="op-email">Email</Label>
              <Input
                id="op-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="alice@example.com"
                autoComplete="off"
                spellCheck={false}
                className="mt-1"
              />
            </div>
            <div>
              <Label htmlFor="op-pubkey">SSH public key</Label>
              <textarea
                id="op-pubkey"
                value={pubkey}
                onChange={(e) => setPubkey(e.target.value)}
                placeholder="ssh-ed25519 AAAAC3NzaC1lZDI1NTE5… alice@laptop"
                autoComplete="off"
                spellCheck={false}
                rows={3}
                className="mt-1 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-background)] p-2 font-mono text-xs"
              />
              <p className="mt-1 text-xs text-[var(--color-muted-foreground)]">
                Paste a single authorized_keys line (ssh-ed25519, ssh-rsa, or ecdsa-sha2-nistp*).
              </p>
            </div>
            <div>
              <Label>Fingerprint (auto-computed)</Label>
              <code className="mt-1 block break-all rounded-md bg-[var(--color-muted)] p-2 font-mono text-xs">
                {fingerprintError ? (
                  <span className="text-[var(--color-destructive)]">{fingerprintError}</span>
                ) : (
                  fingerprint || '—'
                )}
              </code>
            </div>
            <div>
              <Label htmlFor="op-role">Role</Label>
              <Select value={role} onValueChange={(v) => setRole(v as Role)}>
                <SelectTrigger id="op-role" className="mt-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="admin">admin — full read/write/impersonate</SelectItem>
                  <SelectItem value="operator">operator — read + rotate</SelectItem>
                  <SelectItem value="readonly">readonly — read only</SelectItem>
                </SelectContent>
              </Select>
              <p className="mt-1 text-xs text-[var(--color-muted-foreground)]">
                Role sets a default scope preset. Edit below if you need a non-standard grant.
              </p>
            </div>
            <div>
              <Label className="text-xs uppercase tracking-wide text-[var(--color-muted-foreground)]">
                Scopes
              </Label>
              <div className="mt-1 grid grid-cols-2 gap-2">
                {ALL_SCOPES.map((s) => {
                  const checked = scopes.includes(s);
                  const id = `op-scope-${s}`;
                  return (
                    <label
                      key={s}
                      htmlFor={id}
                      className="flex cursor-pointer items-center gap-2 rounded-md border border-[var(--color-border)] px-2 py-1.5 text-xs hover:border-[var(--color-primary)]"
                    >
                      <Checkbox
                        id={id}
                        checked={checked}
                        onCheckedChange={(c) => {
                          setScopesEdited(true);
                          setScopes((prev) =>
                            c === true ? [...prev, s] : prev.filter((x) => x !== s),
                          );
                        }}
                      />
                      <span className="font-mono">{s}</span>
                    </label>
                  );
                })}
              </div>
            </div>
            <ErrorText error={create.error} />
          </div>
          <DialogFooter>
            <Button size="sm" onClick={() => void handleSubmit()} disabled={!canSubmit}>
              {create.isPending ? 'Creating…' : 'Create operator'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <SecretRevealDialog
        open={loginToken !== null}
        onOpenChange={(o) => !o && setLoginToken(null)}
        title="Operator created"
        secretLabel="Login token"
        secret={loginToken}
        note="The new operator pastes this into `polaris-mail login`. Polaris stores only the argon2id hash — there is no way to retrieve this value again."
      />
    </>
  );
}
