---
title: SMTP cookbook
description: Library-by-library SMTPS recipes for the mail-bridge on port 465 — Nodemailer, PHPMailer, Go net/smtp, JavaMail, sendmail/msmtp — plus IMAP retrieval on 993.
sidebar_label: SMTP cookbook
sidebar_position: 4
---

# SMTP cookbook — implicit TLS on port 465

polaris-mail exposes SMTPS (implicit TLS) on **port 465** only. STARTTLS
on 587 is **not** exposed. All examples below use the host
`polaris-mail.<tailnet>.ts.net` and require Tailscale running on the
client (host or container).

The bridge supports a second deployment mode where it binds 465/993
directly on a public hostname (operator-managed TLS); the library configs
below are unchanged — only the host string differs.

## Value prop: Tailscale bypasses cloud port 25/465 blocks

Most cloud providers (Hetzner, OVH, AWS by default) block outbound SMTP.
polaris-mail rides Tailscale's WireGuard tunnel, which is UDP. These
blocks **do not apply**. If you run the bridge in local / host-network
mode, the operator owns firewall posture instead.

## Common gotchas

| Gotcha                | Fix                                                                                       |
| --------------------- | ----------------------------------------------------------------------------------------- |
| STARTTLS-only library | Reconfigure to implicit TLS (`SMTPSecure='ssl'`, `SMTPS`, `SSL=true`, `port=465`).        |
| Cert SAN mismatch     | Always connect to the bridge's exact configured hostname.                                 |
| JDK ≤ 11 trust store  | Some old JDKs reject `.ts.net` LE-issued chains. Upgrade or import the cert.              |
| IDLE poll latency     | ~5 s. IMAP IDLE sees batches every 5 s, not real-time. Real-time inbound is webhook-only. |

## Library-by-library

### Nodemailer (Node.js)

```js
import nodemailer from 'nodemailer';
const t = nodemailer.createTransport({
  host: 'polaris-mail.example.ts.net',
  port: 465,
  secure: true, // implicit TLS
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
});
await t.sendMail({
  from: 'noreply@example.com',
  to: 'user@external.com',
  subject: 'Hi',
  text: 'Hello',
});
```

### PHPMailer

```php
$mail = new PHPMailer(true);
$mail->isSMTP();
$mail->Host       = 'polaris-mail.example.ts.net';
$mail->SMTPAuth   = true;
$mail->Username   = $_ENV['SMTP_USER'];
$mail->Password   = $_ENV['SMTP_PASS'];
$mail->SMTPSecure = PHPMailer::ENCRYPTION_SMTPS; // implicit TLS — NOT STARTTLS
$mail->Port       = 465;
```

### Go `net/smtp`

```go
import (
    "crypto/tls"
    "net/smtp"
)
auth := smtp.PlainAuth("", user, pass, "polaris-mail.example.ts.net")
conn, err := tls.Dial("tcp", "polaris-mail.example.ts.net:465", &tls.Config{ServerName: "polaris-mail.example.ts.net"})
if err != nil { panic(err) }
c, err := smtp.NewClient(conn, "polaris-mail.example.ts.net")
if err != nil { panic(err) }
if err := c.Auth(auth); err != nil { panic(err) }
// ... c.Mail, c.Rcpt, c.Data
```

### Java JavaMail

```java
Properties p = new Properties();
p.put("mail.smtp.host", "polaris-mail.example.ts.net");
p.put("mail.smtp.port", "465");
p.put("mail.smtp.auth", "true");
p.put("mail.smtp.ssl.enable", "true");                // implicit TLS
p.put("mail.smtp.starttls.enable", "false");
p.put("mail.smtp.ssl.checkserveridentity", "true");
Session s = Session.getInstance(p, new Authenticator() {
    protected PasswordAuthentication getPasswordAuthentication() {
        return new PasswordAuthentication(System.getenv("SMTP_USER"), System.getenv("SMTP_PASS"));
    }
});
```

### sendmail / msmtp config

```ini
# /etc/msmtprc
account polaris
host polaris-mail.example.ts.net
port 465
tls on
tls_starttls off
auth on
user $SMTP_USER
password_eval "cat /etc/msmtp/secret"
```

## IMAP retrieval

Identical credentials. Port **993** (implicit TLS).

```sh
# mutt
set imap_user="$SMTP_USER"
set imap_pass="$SMTP_PASS"
set folder="imaps://polaris-mail.example.ts.net:993"
```

```sh
# aerc, isync, fetchmail — same host/port/TLS settings.
```

## SMTP reply code mapping

When the bridge translates polaris-mail REST errors back to SMTP reply
codes, it uses this table:

| polaris-mail code      | SMTP reply   |
| ---------------------- | ------------ |
| `scope_violation`      | `550 5.7.1`  |
| `rate_limited`         | `451 4.7.1`  |
| `domain_not_verified`  | `550 5.7.10` |
| `key_revoked`          | `535 5.7.8`  |
| `bad_signature`        | `535 5.7.8`  |
| `cf_upstream`          | `421 4.3.0`  |
| `nonce_replay`         | `550 5.7.1`  |
| `recipient_rejected`   | `550 5.1.1`  |
| `idempotency_conflict` | `550 5.7.1`  |
| `degraded`             | `421 4.3.0`  |

<!-- Verified against: docs/smtp-cookbook/README.md @ 60cc6d59541b3279a65c755222fd9290ce76fc5e -->
