# Todo SaaS

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

Before public launch, change `JWT_SECRET` in [docker-compose.yml](/home/chris/Documents/todo-saas/docker-compose.yml) to a long random secret.

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
- Owners can add existing registered users to the current workspace by email
- The selected workspace determines API scope and WebSocket broadcasts

## Next logical upgrades

- Email-based invitations instead of add-by-email for existing users only
- Role management beyond `owner` and `member`
- Password reset and email verification
- Billing, organizations, and audit logs
