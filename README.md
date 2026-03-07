# Todo SaaS

This is a Vue-based replacement for the original `todo/` Firebase app. It keeps the simple collaborative todo workflow, but moves the realtime layer and persistence into your own stack:

- `client/`: Vue 3 + Vite frontend
- `server/`: Express API + WebSocket server
- `server/data/todo-saas.db`: SQLite database created automatically on first run

## Why this is a better base

- No Firebase or Google hosted realtime database
- Free local database using SQLite
- WebSocket-based realtime sync you control
- Cleaner path toward a SaaS architecture with `workspaces`, `users`, `lists`, and `tasks`
- Easy future migration from SQLite to Postgres because the backend owns the data model

## Run it

Install dependencies in both app halves:

```bash
cd todo-saas/client && npm install
cd ../server && npm install
```

In one terminal, run the API and WebSocket server:

```bash
cd todo-saas/server
npm run dev
```

In another terminal, run the Vue client:

```bash
cd todo-saas/client
npm run dev
```

Open the Vite URL, usually `http://localhost:5173`.

## Production flow

Build the Vue app:

```bash
cd todo-saas/client
npm run build
```

Then start the backend, which serves the built client from `client/dist`:

```bash
cd ../server
npm start
```

## Notes

- The backend seeds a default workspace and a few starter tasks.
- WebSocket clients receive change events and reload the latest snapshot.
- Right now the app uses one seeded user; multi-user auth is the next logical SaaS upgrade.
- If you outgrow SQLite, keep the API contract and swap the database layer for Postgres.
