# Todo SaaS

This app has been upgraded from the original static/Firebase todo into a Vue + Node SaaS foundation with:

- Vue 3 frontend via Vite
- Express API
- Postgres database
- JWT authentication
- Multi-user workspaces and workspace membership
- WebSocket realtime updates scoped per workspace

## Project layout

- `client/`: Vue application
- `server/`: Express + WebSocket API
- `server/sql/schema.sql`: Postgres schema reference
- `server/.env.example`: required backend environment variables

## Backend requirements

You need a running Postgres database. The fastest local option is Docker Compose.

## One-command startup

From the project root:

```bash
docker compose up --build
```

That starts:

- Postgres on `localhost:5432`
- API server on `localhost:3011`
- Vue client on `localhost:5173`

Open:

```text
http://localhost:5173
```

The client proxies API and WebSocket traffic to the backend container automatically.

## Docker services

If you only want the database, you can still run just Postgres:

```bash
docker compose up -d postgres
```

The Postgres container uses:

- database: `todo_saas`
- user: `postgres`
- password: `postgres`

To stop it:

```bash
docker compose down
```

To stop it and delete the database volume:

```bash
docker compose down -v
```

## Backend environment

Default local connection string:

```bash
postgres://postgres:postgres@localhost:5432/todo_saas
```

Create a `.env` file in `server/` based on `.env.example` only if you want to run the backend outside Docker.

If port `3001` is already in use on your machine, change `PORT` in `server/.env` to another port such as `3011`.

## Install

```bash
cd client && npm install
cd ../server && npm install
```

## Local development without Docker for app services

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

If the backend is not running on `3001`, start the client with a matching proxy target:

```bash
VITE_API_TARGET=http://localhost:3011 npm run dev
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
