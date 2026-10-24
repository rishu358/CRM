# Providers: email and file storage

The application talks to email and file storage through interfaces (ADR-0009), and which vendor sits
behind each is a setting, not a code change. This page says what to set for each supported choice. Every
variable is documented in [`CONFIGURATION.md`](CONFIGURATION.md); the reasoning is in ADR-0048.

Nothing in the code names a host. A vendor's address appears only inside its adapter.

## Email: `EMAIL_PROVIDER`

| Value     | Delivers | Use for                                                                             |
| --------- | -------- | ----------------------------------------------------------------------------------- |
| `console` | no       | Local development: the message, links included, is printed to the log.              |
| `memory`  | no       | Tests and CI: messages are kept in memory so a test can read the token out of them. |
| `resend`  | yes      | Production, through [Resend](https://resend.com).                                   |
| `ses`     | yes      | Production, through [Amazon SES](https://aws.amazon.com/ses/).                      |

`console` and `memory` are refused when `NODE_ENV=production`, and both the API and the worker refuse to
start in production without a provider that delivers. `EMAIL_FROM` must be an address on a domain you
verified with the provider (SPF and DKIM), or mail is not delivered.

### Resend

```
EMAIL_PROVIDER=resend
EMAIL_FROM=App <no-reply@mail.example.com>
RESEND_API_KEY=<a key created for this environment, sending access only>
```

### Amazon SES

```
EMAIL_PROVIDER=ses
EMAIL_FROM=App <no-reply@mail.example.com>
SES_REGION=ap-south-1
SES_ACCESS_KEY_ID=<an IAM access key>
SES_SECRET_ACCESS_KEY=<its secret>
SES_CONFIGURATION_SET=<optional>
```

Before it will deliver:

1. **Verify the sender** (a domain, ideally) in the **same region** as `SES_REGION`.
2. **Leave the sandbox.** A new SES account can only send to addresses it has verified; request production
   access in the SES console, or sign-in verification mail to real users is refused.
3. **Use a narrow IAM user.** One whose only permission is `ses:SendEmail` on that identity. Never a root or
   administrator key. Create one per environment, so a key can be rotated without touching the others.

`SES_REGION` is also where the message is processed, which matters for data residency (see RUNBOOK §9.10
for how this is treated for Resend).

The SES adapter signs its own requests (AWS Signature Version 4) and sends them through the application's
guarded outbound client, pinned to `email.<region>.amazonaws.com` over https. The China regions and temporary
(session-token) credentials are not supported.

### SMTP

```
EMAIL_PROVIDER=smtp
EMAIL_FROM=App <no-reply@mail.example.com>
SMTP_HOST=smtp.mail.example.com
SMTP_PORT=587
SMTP_SECURITY=starttls
SMTP_USER=<the login>
SMTP_PASSWORD=<its password>
```

For a company's own mail server or any relay. `SMTP_SECURITY` is how the connection is protected:

| Value      | Port | What it does                                                                                                                                                                    |
| ---------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `starttls` | 587  | Connects in clear and **requires** the upgrade to TLS. A server that does not offer it, or a downgrade by someone in the middle, makes the send fail: nothing is sent in clear. |
| `tls`      | 465  | TLS from the first byte.                                                                                                                                                        |
| `none`     | any  | Plain text, for a local development inbox only. **Refused in production.**                                                                                                      |

Certificates are verified (a self-signed one is refused: use a certificate the server's name matches) and TLS 1.2
is the minimum. `SMTP_USER` and `SMTP_PASSWORD` are set together, or both left unset for a relay that trusts the
sender by address. The server is the operator's choice and never comes from a request, so one on a private
network is fine.

Failures are reported as a code and an SMTP status, never the server's own text, which often repeats the
recipient's address.

## File storage: `STORAGE_PROVIDER`

`s3` is any S3-compatible store; `memory` is for tests and is refused in production (the API and the worker
would each hold their own empty store). Files move from the browser to the store and never through the API,
so **the bucket's CORS must allow `PUT` and `GET` from your web origin only**, or uploads fail while
everything else looks fine.

There are no vendor presets in code, on purpose (ADR-0048): a preset is a vendor's hostname in application
code. The values for each store are below, so they are set once, in the environment.

| Variable               | AWS S3                           | Cloudflare R2                                   | DigitalOcean Spaces                       | MinIO (local development)      |
| ---------------------- | -------------------------------- | ----------------------------------------------- | ----------------------------------------- | ------------------------------ |
| `S3_BUCKET`            | your bucket                      | your bucket                                     | your bucket                               | `crm-files`                    |
| `S3_REGION`            | the bucket's region              | `auto`                                          | `us-east-1` (the endpoint picks the site) | `us-east-1`                    |
| `S3_ENDPOINT`          | unset                            | `https://<account-id>.r2.cloudflarestorage.com` | `https://<region>.digitaloceanspaces.com` | `http://localhost:19000`       |
| `S3_PUBLIC_ENDPOINT`   | unset                            | unset                                           | same as `S3_ENDPOINT`                     | `http://localhost:19000`       |
| `S3_FORCE_PATH_STYLE`  | `false`                          | `false`                                         | `true`                                    | `true`                         |
| `S3_ACCESS_KEY_ID`     | an IAM key limited to the bucket | an R2 API token's key                           | a Spaces access key                       | `crm_minio` (development only) |
| `S3_SECRET_ACCESS_KEY` | its secret                       | its secret                                      | its secret                                | development only               |

What was verified: the DigitalOcean Spaces and MinIO columns follow the deployment recipe in RUNBOOK §9 and the
local setup; the S3 column follows the SDK's defaults. **The Cloudflare R2 column was written from its
documentation and has not been run against a live bucket**, so confirm a test upload and download (and the
bucket's CORS) before relying on it.

In production `S3_PUBLIC_ENDPOINT` must be https and not point at this machine; the API refuses to start
otherwise.
