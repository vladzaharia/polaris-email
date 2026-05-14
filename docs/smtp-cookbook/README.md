# SMTP cookbook — implicit TLS on port 465

polaris-email exposes SMTPS (implicit TLS) on **port 465** only. STARTTLS on 587 is **not** exposed. All examples below use the host `polaris-email.<tailnet>.ts.net` and require Tailscale running on the client (host or container).

## Value prop: Tailscale bypasses cloud port 25/465 blocks

Most cloud providers (Hetzner, OVH, AWS by default) block outbound SMTP. polaris-email rides Tailscale's WireGuard tunnel, which is UDP. These blocks **do not apply**.

## Common gotchas

- **STARTTLS-only libraries**: not supported. Reconfigure to implicit TLS (`SMTPSecure='ssl'`, `SMTPS`, `SSL=true`, `port=465`).
- **Cert SAN**: The submission daemon presents a cert valid for its configured hostname. Always connect to that exact hostname.
- **JDK ≤ 11 trust store**: some old JDKs reject `.ts.net` LE-issued chains. Either upgrade or import the cert into the keystore.
- **IDLE poll latency**: ~5 s. IMAP IDLE clients see batches every 5 s, not real-time. Real-time inbound is webhook-only.

## Library-by-library

### Nodemailer (Node.js)

```js
import nodemailer from 'nodemailer';
const t = nodemailer.createTransport({
  host: 'polaris-email.example.ts.net',
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
$mail->Host       = 'polaris-email.example.ts.net';
$mail->SMTPAuth   = true;
$mail->Username   = $_ENV['SMTP_USER'];
$mail->Password   = $_ENV['SMTP_PASS'];
$mail->SMTPSecure = PHPMailer::ENCRYPTION_SMTPS; // implicit TLS — NOT STARTTLS
$mail->Port       = 465;
```

### Python `smtplib`

```python
import smtplib, ssl, os
ctx = ssl.create_default_context()
with smtplib.SMTP_SSL('polaris-email.example.ts.net', 465, context=ctx) as s:
    s.login(os.environ['SMTP_USER'], os.environ['SMTP_PASS'])
    s.send_message(msg)
```

### Go `net/smtp`

```go
import (
    "crypto/tls"
    "net/smtp"
)
auth := smtp.PlainAuth("", user, pass, "polaris-email.example.ts.net")
conn, err := tls.Dial("tcp", "polaris-email.example.ts.net:465", &tls.Config{ServerName: "polaris-email.example.ts.net"})
if err != nil { panic(err) }
c, err := smtp.NewClient(conn, "polaris-email.example.ts.net")
if err != nil { panic(err) }
if err := c.Auth(auth); err != nil { panic(err) }
// ... c.Mail, c.Rcpt, c.Data
```

### Java JavaMail

```java
Properties p = new Properties();
p.put("mail.smtp.host", "polaris-email.example.ts.net");
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
host polaris-email.example.ts.net
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
set folder="imaps://polaris-email.example.ts.net:993"
```

```sh
# aerc, isync, fetchmail — same host/port/TLS settings.
```

## SMTP reply code mapping

When the bridge translates polaris-email REST errors back to SMTP reply codes, it uses this table:

| polaris-email code     | SMTP reply   |
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
