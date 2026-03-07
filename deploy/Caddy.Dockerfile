FROM node:20-alpine AS frontend-builder

WORKDIR /app/client

COPY client/package*.json ./
RUN npm ci

COPY client/ ./
RUN npm run build

FROM caddy:2.8-alpine

COPY deploy/Caddyfile /etc/caddy/Caddyfile
COPY --from=frontend-builder /app/client/dist /usr/share/caddy

EXPOSE 80 443
