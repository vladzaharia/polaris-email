// BridgeSettingsCard — Settings tab on the bridge Detail page.
//
// Form-per-field. Save → PUT /api/admin/bridges/:id/settings. The
// server bumps `version`; the bridge picks up the new settings on its
// next heartbeat. Service toggles + log level hot-reload in place;
// port + TLS-source changes trigger a bridge process restart
// (compose's restart: unless-stopped brings it back in ~5s) and we
// warn explicitly when those are dirty.
//
// Heartbeat v2.1: each protocol has an encrypted (SMTPS / IMAPS) and
// an unencrypted (SMTP / IMAP) variant; all four can be enabled
// simultaneously with their own ports.
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
  smtps_enabled: boolean;
  smtps_port: number;
  smtp_enabled: boolean;
  smtp_port: number;
  imaps_enabled: boolean;
  imaps_port: number;
  imap_enabled: boolean;
  imap_port: number;
  tls_source: 'auto' | 'manual';
  max_message_size_bytes: number;
  max_imap_sessions: number;
  log_level: 'debug' | 'info' | 'warn' | 'error';
  webhook_enabled: boolean;
  webhook_url_override: string | null;
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
    draft.smtps_port !== current.smtps_port ||
    draft.smtp_port !== current.smtp_port ||
    draft.imaps_port !== current.imaps_port ||
    draft.imap_port !== current.imap_port ||
    draft.tls_source !== current.tls_source ||
    draft.max_message_size_bytes !== current.max_message_size_bytes ||
    draft.max_imap_sessions !== current.max_imap_sessions ||
    (draft.webhook_url_override ?? '') !== (current.webhook_url_override ?? '');

  return (
    <section className="space-y-6">
      <div className="rounded-md border border-[var(--color-border)] p-4">
        <h2 className="mb-3 text-base font-semibold">Listeners</h2>
        <p className="mb-3 text-xs text-[var(--color-muted-foreground)]">
          The bridge can serve any combination of these four listeners simultaneously. SMTPS + IMAPS
          use the shared TLS source below; SMTP + IMAP run unencrypted (intended for tailnet-only or
          private-network deployments).
        </p>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <ListenerCard
            id="smtps"
            label="SMTPS"
            sublabel="Encrypted SMTP submission"
            enabled={draft.smtps_enabled}
            port={draft.smtps_port}
            defaultPort={465}
            onEnabledChange={(v) => setDraft({ ...draft, smtps_enabled: v })}
            onPortChange={(v) => setDraft({ ...draft, smtps_port: v })}
          />
          <ListenerCard
            id="smtp"
            label="SMTP"
            sublabel="Unencrypted SMTP submission"
            enabled={draft.smtp_enabled}
            port={draft.smtp_port}
            defaultPort={25}
            onEnabledChange={(v) => setDraft({ ...draft, smtp_enabled: v })}
            onPortChange={(v) => setDraft({ ...draft, smtp_port: v })}
          />
          <ListenerCard
            id="imaps"
            label="IMAPS"
            sublabel="Encrypted IMAP read"
            enabled={draft.imaps_enabled}
            port={draft.imaps_port}
            defaultPort={993}
            onEnabledChange={(v) => setDraft({ ...draft, imaps_enabled: v })}
            onPortChange={(v) => setDraft({ ...draft, imaps_port: v })}
          />
          <ListenerCard
            id="imap"
            label="IMAP"
            sublabel="Unencrypted IMAP read"
            enabled={draft.imap_enabled}
            port={draft.imap_port}
            defaultPort={143}
            onEnabledChange={(v) => setDraft({ ...draft, imap_enabled: v })}
            onPortChange={(v) => setDraft({ ...draft, imap_port: v })}
          />
        </div>
      </div>

      <div className="rounded-md border border-[var(--color-border)] p-4">
        <h2 className="mb-3 text-base font-semibold">TLS source</h2>
        <p className="mb-3 text-xs text-[var(--color-muted-foreground)]">
          Where the SMTPS and IMAPS listeners get their cert + key. Auto = embedded ACME (Let's
          Encrypt via Cloudflare DNS-01). Manual = operator-supplied PEMs at the bridge's cert dir.
        </p>
        <SelectField
          id="tls_source"
          label="Source"
          value={draft.tls_source}
          options={TLS_SOURCES}
          onChange={(v) => setDraft({ ...draft, tls_source: v as BridgeSettings['tls_source'] })}
        />
      </div>

      <div className="rounded-md border border-[var(--color-border)] p-4">
        <div className="mb-2 flex items-start justify-between gap-2">
          <div>
            <h2 className="text-base font-semibold">Webhook receiver</h2>
            <p className="text-xs text-[var(--color-muted-foreground)]">
              Inbound mail push from polaris. When enabled, the bridge listens on :8080 and
              registers a per-mailbox webhook subscription so IMAP IDLE clients see new mail
              immediately. URL is auto-derived (tailnet MagicDNS →{' '}
              <code>&lt;name&gt;.mail.plrs.im</code> → raw IP); override below only if you need a
              specific transport.
            </p>
          </div>
          <Switch
            id="webhook_enabled"
            checked={draft.webhook_enabled}
            onCheckedChange={(v) => setDraft({ ...draft, webhook_enabled: v })}
          />
        </div>
        <div className="mt-3">
          <Label htmlFor="webhook_url_override" className="text-xs">
            URL override (optional)
          </Label>
          <Input
            id="webhook_url_override"
            type="url"
            placeholder="auto-derive (recommended)"
            value={draft.webhook_url_override ?? ''}
            disabled={!draft.webhook_enabled}
            onChange={(e) => {
              const v = e.target.value.trim();
              setDraft({ ...draft, webhook_url_override: v === '' ? null : v });
            }}
          />
          <p className="mt-1 text-xs text-[var(--color-muted-foreground)]">
            Changing the URL re-registers the subscription with polaris on next bridge restart.
          </p>
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

const TLS_SOURCES = [
  { value: 'auto', label: 'auto (embedded ACME)' },
  { value: 'manual', label: 'manual (operator PEMs)' },
];
const LOG_LEVELS = [
  { value: 'debug', label: 'debug' },
  { value: 'info', label: 'info' },
  { value: 'warn', label: 'warn' },
  { value: 'error', label: 'error' },
];

function ListenerCard(props: {
  id: string;
  label: string;
  sublabel: string;
  enabled: boolean;
  port: number;
  defaultPort: number;
  onEnabledChange: (v: boolean) => void;
  onPortChange: (v: number) => void;
}) {
  return (
    <div className="rounded-md border border-[var(--color-border)] p-3">
      <div className="mb-2 flex items-start justify-between gap-2">
        <div>
          <Label htmlFor={`${props.id}_enabled`} className="text-sm font-semibold">
            {props.label}
          </Label>
          <p className="text-xs text-[var(--color-muted-foreground)]">{props.sublabel}</p>
        </div>
        <Switch
          id={`${props.id}_enabled`}
          checked={props.enabled}
          onCheckedChange={props.onEnabledChange}
        />
      </div>
      <div>
        <Label htmlFor={`${props.id}_port`} className="text-xs">
          Port
        </Label>
        <Input
          id={`${props.id}_port`}
          type="number"
          min={1}
          max={65535}
          value={props.port}
          placeholder={String(props.defaultPort)}
          onChange={(e) => {
            const n = Number.parseInt(e.target.value, 10);
            if (Number.isFinite(n)) props.onPortChange(n);
          }}
        />
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
    a.smtps_enabled === b.smtps_enabled &&
    a.smtps_port === b.smtps_port &&
    a.smtp_enabled === b.smtp_enabled &&
    a.smtp_port === b.smtp_port &&
    a.imaps_enabled === b.imaps_enabled &&
    a.imaps_port === b.imaps_port &&
    a.imap_enabled === b.imap_enabled &&
    a.imap_port === b.imap_port &&
    a.tls_source === b.tls_source &&
    a.max_message_size_bytes === b.max_message_size_bytes &&
    a.max_imap_sessions === b.max_imap_sessions &&
    a.log_level === b.log_level &&
    a.webhook_enabled === b.webhook_enabled &&
    (a.webhook_url_override ?? '') === (b.webhook_url_override ?? '')
  );
}

function diff(prev: BridgeSettings, next: BridgeSettings): Partial<BridgeSettings> {
  const out: Partial<BridgeSettings> = {};
  const cmp = <K extends keyof BridgeSettings>(k: K): void => {
    if (prev[k] !== next[k]) (out as Record<string, unknown>)[k] = next[k];
  };
  cmp('smtps_enabled');
  cmp('smtps_port');
  cmp('smtp_enabled');
  cmp('smtp_port');
  cmp('imaps_enabled');
  cmp('imaps_port');
  cmp('imap_enabled');
  cmp('imap_port');
  cmp('tls_source');
  cmp('max_message_size_bytes');
  cmp('max_imap_sessions');
  cmp('log_level');
  cmp('webhook_enabled');
  if ((prev.webhook_url_override ?? '') !== (next.webhook_url_override ?? '')) {
    out.webhook_url_override = next.webhook_url_override;
  }
  return out;
}
