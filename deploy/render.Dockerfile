# One-service hosting (Render, see render.yaml): the website and the Go
# server in one image; the server serves the website (STATIC_DIR) on the
# same address as the API. The normal deploy (docker-compose.yml) uses
# web.Dockerfile + Caddy instead. Build context: the repository root.
FROM node:22-alpine AS web
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci
COPY index.html vite.config.ts tsconfig.json ./
COPY src ./src
ENV VITE_DATA_SOURCE=api
RUN npm run build

FROM golang:1.27-alpine AS server
WORKDIR /src
COPY golang-backend/go.mod golang-backend/go.sum ./
RUN go mod download
COPY golang-backend/ .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/arena-backend .

FROM alpine:3.22
RUN adduser -D -u 10001 arena && mkdir -p /app/uploads && chown arena /app/uploads
WORKDIR /app
COPY --from=server /out/arena-backend /app/arena-backend
COPY --from=web /src/dist /app/web
USER arena
# Slip images are kept in /app/uploads: on Render's free plan that disk is
# wiped on every restart or deploy (fine for testing).
ENV GIN_MODE=release PORT=8080 STATIC_DIR=/app/web
EXPOSE 8080
STOPSIGNAL SIGTERM
ENTRYPOINT ["/app/arena-backend"]
