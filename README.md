# EarnBox

EarnBox is a full-stack rewards application, kept in `earnbox/` so it does not overwrite the existing Roof Runner GitHub Pages game. It includes signup/login, referral credits, daily bonuses, task listings, points history, payout requests, an admin console, encrypted payout details, and an idempotent signed offer-credit callback.

## Run locally

Requirements: Node.js 20+ and PostgreSQL 14+.

1. Create a PostgreSQL database and copy `earnbox/.env.example` to `.env` in the repository root.
2. Fill in `DATABASE_URL`, a unique `ADMIN_PASSWORD` (at least 12 characters), `POSTBACK_SECRET` (at least 32 characters), and a random 32-byte `PAYOUT_ENCRYPTION_KEY` (64 hex characters). Generate secrets with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
3. Set `PUBLIC_URL` to the URL where this app will be served. Never commit `.env` or share the secrets.
4. Install and start:

   ```sh
   npm install
   npm start
   ```

5. Open `http://localhost:3000`; the admin page is at `/admin`.

The schema is initialized automatically on startup. Use PostgreSQL backups and keep the encryption key backed up separately: payout details cannot be recovered if that key is lost.

## Deploy

Deploy the repository to a Node.js host with a managed PostgreSQL database. Configure the environment variables from `.env.example` in the host's secret manager, enable HTTPS, and set `PUBLIC_URL` to the exact public origin. This application uses secure cookies in production and expects to run behind one trusted proxy. Configure database backups, monitoring, log retention, and a process manager/health checks before accepting real users. GitHub Pages is static hosting only and cannot run this backend; the existing Pages site remains Roof Runner.

## Offer/reward provider integration

The provider must call `POST /api/postback` with JSON `{ "user_id": 123, "points": 150, "txid": "unique-provider-transaction", "signature": "..." }`. The signature is lowercase/uppercase hex HMAC-SHA256 of the UTF-8 string `user_id:points:txid`, keyed by `POSTBACK_SECRET`. Example signature generation:

```js
crypto.createHmac('sha256', process.env.POSTBACK_SECRET)
  .update(`${user_id}:${points}:${txid}`).digest('hex')
```

Configure and test this with your provider before advertising rewards. Repeated transaction IDs are idempotent. Do not expose `POSTBACK_SECRET` in client code. Provider terms, fraud controls, payout rules, and local legal/tax requirements need to be reviewed before launch.

## Important production notes

- This is a deployable product foundation, not a payment processor. Payout requests are manually reviewed in `/admin`; no money is automatically sent.
- The default task entries are examples and do not award points by themselves. Real offers need a provider and verified signed callbacks.
- The admin password is supplied through environment configuration; rotate it through your host's secret settings. Admin sessions and user sessions are stored hashed in PostgreSQL.
- Add your privacy policy, terms, support contact, provider-specific callback configuration, and jurisdiction-appropriate compliance review before public launch.
