# Todo SaaS / Task List

This app has been upgraded from the original static/Firebase todo into a Vue + Node SaaS foundation with:

- Vue 3 frontend via Vite
- Express API
- Caddy reverse proxy for production HTTPS
- Postgres database
- JWT authentication
- Multi-user workspaces and workspace membership
- WebSocket realtime updates scoped per workspace

## Project layout

- `client/`: Vue application
- `server/`: Express + WebSocket API
- `deploy/Caddyfile`: public reverse proxy and TLS config
- `deploy/Caddy.Dockerfile`: production web image that builds the Vue app
- `server/sql/schema.sql`: Postgres schema reference
- `server/.env.example`: required backend environment variables

## One-command startup

From the project root:

```bash
docker compose up --build -d
```

That starts:

- Postgres on the internal Docker network
- API server on the internal Docker network
- Caddy on public ports `80` and `443`

Open:

```text
https://tasked.lol
```

Caddy serves the built Vue app, terminates HTTPS, and proxies API and WebSocket traffic to the backend container.

## DNS and Router Setup

- Point `tasked.lol` and optionally `www.tasked.lol` to your home public IP with `A` records.
- Forward router ports:
  - external `80` -> Pi `80`
  - external `443` -> Pi `443`
- Keep ports `3001`, `5173`, and `5432` private.

To stop it:

```bash
docker compose down
```

To stop it and delete the database volume:

```bash
docker compose down -v
```

## Backend environment

Inside Docker, the API uses:

```bash
postgres://postgres:postgres@postgres:5432/todo_saas
```

Production secrets should live in a Pi-only file at `deploy/pi.env`, not in version-controlled YAML.

Create it on the Pi from [pi.env.example](/home/chris/Documents/todo-saas/deploy/pi.env.example):

```bash
cp deploy/pi.env.example deploy/pi.env
```

Then edit `deploy/pi.env` and set:

- `POSTGRES_PASSWORD`
- `DATABASE_URL`
- `JWT_SECRET`
- `CLIENT_ORIGIN`
- `SERVER_ORIGIN`
- `GOOGLE_AUTH_ENABLED`
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `APPLE_AUTH_ENABLED`
- `APPLE_CLIENT_ID`
- `APPLE_TEAM_ID`
- `APPLE_KEY_ID`
- `APPLE_PRIVATE_KEY`
- `INVITE_EMAILS_ENABLED`
- `INVITE_EMAIL_PROVIDER`
- `RESEND_API_KEY`
- `INVITE_FROM_EMAIL`
- `INVITE_FROM_NAME`
- `PORT`

`deploy/pi.env` is ignored by git and should exist only on the server.

## Operations

### Manual database backup

On the Pi:

```bash
cd /home/retropi/apps/todo-saas
bash deploy/backup.sh
```

Backups are written to:

```text
/home/retropi/backups/todo-saas
```

The script keeps 14 days of `.sql.gz` backups by default and refreshes a `latest.sql.gz` symlink.

### Automated daily backups

On the Pi, edit the crontab:

```bash
crontab -e
```

Add a nightly job, for example at `2:15 AM`:

```cron
15 2 * * * /bin/bash /home/retropi/apps/todo-saas/deploy/backup.sh >> /home/retropi/backups/todo-saas/backup.log 2>&1
```

### Safe Postgres password rotation

On the Pi:

```bash
cd /home/retropi/apps/todo-saas
bash deploy/rotate-postgres-password.sh
```

If you do not pass a password, the script generates one for you. It will:

- take a backup first
- change the live `postgres` role password
- update `deploy/pi.env`
- recreate the API container
- verify app health

You can also provide a password explicitly:

```bash
bash deploy/rotate-postgres-password.sh your-new-strong-password
```

## Install

```bash
cd client && npm install
cd ../server && npm install
```

## Local development without Docker

Run the server:

```bash
cd server
npm run dev
```

Run the client in another terminal:

```bash
cd client
npm run dev
```

## Auth flow

- Register creates a user account and a first workspace
- Login returns all workspaces the user belongs to
- Google sign-in can either log into an existing account or create a new one with a default workspace
- Apple sign-in can either log into an existing account or create a new one with a default workspace
- Owners can generate invite links for email addresses from the current workspace
- Invite links can be accepted by an existing account with the invited email, or by registering a new account for that email
- Lists can be created as `task` lists or `grocery` lists, and item fields adapt to the selected list type
- The selected workspace determines API scope and WebSocket broadcasts

## Google OAuth setup

Create a Google OAuth client in Google Cloud Console with:

- Authorized JavaScript origins:
  - `https://tasked.lol`
  - `http://localhost:5173` for local dev if you want the frontend to launch the flow locally
- Authorized redirect URIs:
  - `https://tasked.lol/api/auth/google/callback`
  - `http://localhost:3001/api/auth/google/callback`

Then set:

- `GOOGLE_AUTH_ENABLED=true`
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `SERVER_ORIGIN`

## Apple Sign In setup

Create a Sign in with Apple Service ID and key in the Apple Developer portal, then set:

- `APPLE_AUTH_ENABLED=true`
- `APPLE_CLIENT_ID`
- `APPLE_TEAM_ID`
- `APPLE_KEY_ID`
- `APPLE_PRIVATE_KEY`

Configure the return URL:

- `https://tasked.lol/api/auth/apple/callback`

Apple requires an HTTPS redirect URL for web sign-in and does not support `http://localhost` callbacks for this flow, so local Apple testing needs a real HTTPS domain or tunnel.

If you want Apple hidden for now, leave `APPLE_AUTH_ENABLED=false`.

## Invite email setup

Invite delivery is feature-flagged. To enable invite emails through Resend, set:

- `INVITE_EMAILS_ENABLED=true`
- `INVITE_EMAIL_PROVIDER=resend`
- `RESEND_API_KEY`
- `INVITE_FROM_EMAIL`
- `INVITE_FROM_NAME`

The invite record is still created even if email delivery is disabled or fails. In that case, the UI keeps showing the invite link so it can be copied manually.

Before sending from Resend, verify the sending domain or sender address in your Resend account. Their official docs cover the send-email API and domain setup:

- https://resend.com/docs/api-reference/emails/send-email
- https://resend.com/docs/dashboard/domains/introduction

## Next logical upgrades

- Role management beyond `owner` and `member`
- Password reset and email verification
- Billing, organizations, and audit logs
