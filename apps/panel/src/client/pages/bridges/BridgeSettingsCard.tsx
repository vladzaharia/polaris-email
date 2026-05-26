// BridgeSettingsCard — Settings tab on the bridge Detail page.
//
// Form-per-field. Save → PUT /api/admin/bridges/:id/settings. The
// server bumps `version`; the bridge picks up the new settings on its
// next heartbeat. Most fields hot-reload; port/TLS-mode changes
// trigger a bridge process restart (compose's restart: unless-stopped
// brings it back in ~5s) and we warn explicitly when those are dirty.
import { useEffect, useState } from 'react';
import { Save, RefreshCw } from 'lucide-react';
import { Button } from '../../components/ui/button.js';
import { Input } from '../../components/ui/input.js';
import { Label } from '../../components/ui/label.js';
import { Switch } from '../../components/ui/switch.js';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../components/ui/select.js';
import { Skeleton } from '../../components/ui/skeleton.js';
import { ErrorText } from '../../components/ErrorText.js';
import { useAdminMutation, useAdminQuery } from '../../hooks/useAdminApi.js';

interface BridgeSettings {
  bridge_id: string;
  version: number;
  smtp_enabled: boolean;
  imap_enabled: boolean;
  smtp_port: number;
  imap_port: number;
  smtp_tls_mode: 'auto' | 'manual' | 'off';
  imap_tls_mode: 'auto' | 'manual' | 'off';
  max_message_size_bytes: number;
  max_imap_sessions: number;
  log_level: 'debug' | 'info' | 'warn' | 'error';
  updated_at: string;
  updated_by: string;
}

interface BridgeSettingsCardProps {
  bridgeId: string;
}

export function BridgeSettingsCard({ bridgeId }: BridgeSettingsCardProps) {
  const settings = useAdminQuery<BridgeSettings>(
    ['bridges', bridgeId, 'settings'],
    `/api/admin/bridges/${bridgeId}/settings`,
  );

  // Local "draft" copy so the operator can edit several fields before
  // saving. Synced from the server on first load and after each save.
  const [draft, setDraft] = useState<BridgeSettings | null>(null);
  useEffect(() => {
    if (settings.data) setDraft(settings.data);
  }, [settings.data]);

  const save = useAdminMutation<BridgeSettings, Partial<BridgeSettings>>(
    (body) => ({
      path: `/api/admin/bridges/${bridgeId}/settings`,
      method: 'PUT',
      body,
    }),
    {
      invalidateKeys: [['bridges', bridgeId, 'settings']],
      successMessage: 'Settings saved. The bridge will apply on its next heartbeat (~60s).',
    },
  );

  if (settings.isLoading || !draft || !settings.data) {
    return (
      <section className="space-y-4">
        <Skeleton className="h-32 w-full" />
      </section>
    );
  }
  if (settings.error) {
    return (
      <section className="space-y-4">
        <ErrorText error={settings.error} />
      </section>
    );
  }

  const current = settings.data;
  const dirty = !shallowEqual(current, draft);
  const restartRequired =
    draft.smtp_port !== current.smtp_port ||
    draft.imap_port !== current.imap_port ||
    draft.smtp_tls_mode !== current.smtp_tls_mode ||
    draft.imap_tls_mode !== current.imap_tls_mode ||
    draft.max_message_size_bytes !== current.max_message_size_bytes ||
    draft.max_imap_sessions !== current.max_imap_sessions;

  return (
    <section className="space-y-6">
      <div className="rounded-md border border-[var(--color-border)] p-4">
        <div className="mb-3 flex items-center justify-between gap-2">
          <h2 className="text-base font-semibold">Service toggles</h2>
          <span className="text-xs text-[var(--color-muted-foreground)]">
            v{current.version} · updated{' '}
            <span title={current.updated_at}>by {current.updated_by}</span>
          </span>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <ToggleRow
            id="smtp_enabled"
            label="SMTP submission"
            description="Accept submitted mail on the SMTPS listener"
            checked={draft.smtp_enabled}
            onCheckedChange={(v) => setDraft({ ...draft, smtp_enabled: v })}
          />
          <ToggleRow
            id="imap_enabled"
            label="IMAP read"
            description="Serve mailboxes over IMAP4rev2"
            checked={draft.imap_enabled}
            onCheckedChange={(v) => setDraft({ ...draft, imap_enabled: v })}
          />
        </div>
      </div>

      <div className="rounded-md border border-[var(--color-border)] p-4">
        <h2 className="mb-3 text-base font-semibold">Ports &amp; TLS</h2>
        <p className="mb-3 text-xs text-[var(--color-muted-foreground)]">
          Changing a port or TLS mode triggers a bridge restart. The process exits and compose
          brings it back with the new binding (~5s downtime).
        </p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <NumberField
            id="smtp_port"
            label="SMTP port"
            value={draft.smtp_port}
            min={1}
            max={65535}
            onChange={(v) => setDraft({ ...draft, smtp_port: v })}
          />
          <NumberField
            id="imap_port"
            label="IMAP port"
            value={draft.imap_port}
            min={1}
            max={65535}
            onChange={(v) => setDraft({ ...draft, imap_port: v })}
          />
          <SelectField
            id="smtp_tls_mode"
            label="SMTP TLS"
            value={draft.smtp_tls_mode}
            options={TLS_OPTIONS}
            onChange={(v) =>
              setDraft({ ...draft, smtp_tls_mode: v as BridgeSettings['smtp_tls_mode'] })
            }
          />
          <SelectField
            id="imap_tls_mode"
            label="IMAP TLS"
            value={draft.imap_tls_mode}
            options={TLS_OPTIONS}
            onChange={(v) =>
              setDraft({ ...draft, imap_tls_mode: v as BridgeSettings['imap_tls_mode'] })
            }
          />
        </div>
      </div>

      <div className="rounded-md border border-[var(--color-border)] p-4">
        <h2 className="mb-3 text-base font-semibold">Limits &amp; logging</h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <NumberField
            id="max_message_size_bytes"
            label="Max message size (bytes)"
            value={draft.max_message_size_bytes}
            min={1024}
            max={1024 * 1024 * 1024}
            step={1024}
            onChange={(v) => setDraft({ ...draft, max_message_size_bytes: v })}
          />
          <NumberField
            id="max_imap_sessions"
            label="Max IMAP sessions"
            value={draft.max_imap_sessions}
            min={1}
            max={10000}
            onChange={(v) => setDraft({ ...draft, max_imap_sessions: v })}
          />
          <SelectField
            id="log_level"
            label="Log level"
            value={draft.log_level}
            options={LOG_LEVELS}
            onChange={(v) => setDraft({ ...draft, log_level: v as BridgeSettings['log_level'] })}
          />
        </div>
      </div>

      <div className="flex items-center gap-3">
        <Button
          size="sm"
          disabled={!dirty || save.isPending}
          onClick={async () => {
            await save.mutateAsync(diff(current, draft));
          }}
        >
          {save.isPending ? (
            <RefreshCw className="h-3.5 w-3.5 animate-spin" aria-hidden />
          ) : (
            <Save className="h-3.5 w-3.5" aria-hidden />
          )}
          {save.isPending ? 'Saving…' : 'Save changes'}
        </Button>
        {restartRequired && dirty ? (
          <span className="text-xs text-[var(--color-warning)]">
            Restart-required change pending — the bridge will exit and re-bind on next heartbeat.
          </span>
        ) : null}
        <ErrorText error={save.error} />
      </div>
    </section>
  );
}

const TLS_OPTIONS = [
  { value: 'auto', label: 'auto (embedded ACME)' },
  { value: 'manual', label: 'manual (operator PEMs)' },
  { value: 'off', label: 'off (plaintext)' },
];
const LOG_LEVELS = [
  { value: 'debug', label: 'debug' },
  { value: 'info', label: 'info' },
  { value: 'warn', label: 'warn' },
  { value: 'error', label: 'error' },
];

function ToggleRow(props: {
  id: string;
  label: string;
  description: string;
  checked: boolean;
  onCheckedChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-start gap-3">
      <Switch id={props.id} checked={props.checked} onCheckedChange={props.onCheckedChange} />
      <div>
        <Label htmlFor={props.id} className="text-sm">
          {props.label}
        </Label>
        <p className="text-xs text-[var(--color-muted-foreground)]">{props.description}</p>
      </div>
    </div>
  );
}

function NumberField(props: {
  id: string;
  label: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  onChange: (v: number) => void;
}) {
  return (
    <div>
      <Label htmlFor={props.id} className="text-sm">
        {props.label}
      </Label>
      <Input
        id={props.id}
        type="number"
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        onChange={(e) => {
          const n = Number.parseInt(e.target.value, 10);
          if (Number.isFinite(n)) props.onChange(n);
        }}
      />
    </div>
  );
}

function SelectField(props: {
  id: string;
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (v: string) => void;
}) {
  return (
    <div>
      <Label htmlFor={props.id} className="text-sm">
        {props.label}
      </Label>
      <Select value={props.value} onValueChange={props.onChange}>
        <SelectTrigger id={props.id}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {props.options.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function shallowEqual(a: BridgeSettings, b: BridgeSettings): boolean {
  return (
    a.smtp_enabled === b.smtp_enabled &&
    a.imap_enabled === b.imap_enabled &&
    a.smtp_port === b.smtp_port &&
    a.imap_port === b.imap_port &&
    a.smtp_tls_mode === b.smtp_tls_mode &&
    a.imap_tls_mode === b.imap_tls_mode &&
    a.max_message_size_bytes === b.max_message_size_bytes &&
    a.max_imap_sessions === b.max_imap_sessions &&
    a.log_level === b.log_level
  );
}

// PUT payload is a partial — only changed fields, so the audit log diff
// stays meaningful.
function diff(prev: BridgeSettings, next: BridgeSettings): Partial<BridgeSettings> {
  const out: Partial<BridgeSettings> = {};
  if (prev.smtp_enabled !== next.smtp_enabled) out.smtp_enabled = next.smtp_enabled;
  if (prev.imap_enabled !== next.imap_enabled) out.imap_enabled = next.imap_enabled;
  if (prev.smtp_port !== next.smtp_port) out.smtp_port = next.smtp_port;
  if (prev.imap_port !== next.imap_port) out.imap_port = next.imap_port;
  if (prev.smtp_tls_mode !== next.smtp_tls_mode) out.smtp_tls_mode = next.smtp_tls_mode;
  if (prev.imap_tls_mode !== next.imap_tls_mode) out.imap_tls_mode = next.imap_tls_mode;
  if (prev.max_message_size_bytes !== next.max_message_size_bytes) {
    out.max_message_size_bytes = next.max_message_size_bytes;
  }
  if (prev.max_imap_sessions !== next.max_imap_sessions) {
    out.max_imap_sessions = next.max_imap_sessions;
  }
  if (prev.log_level !== next.log_level) out.log_level = next.log_level;
  return out;
}
