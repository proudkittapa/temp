# The Go backend: built from the whole package (main.go alone misses the
# other files in package main), run as a small static binary.
FROM golang:1.25-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
# Build caches kept between builds (BuildKit, Docker's default builder): an
# update recompiles only the changed code, not every library again.
RUN --mount=type=cache,target=/go/pkg/mod go mod download
COPY . .
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/arena-backend .

FROM alpine:3.22
# The base image has the CA certificates and busybox wget (health check) and
# tar (backups); Bangkok time is built into the binary (time/tzdata).
RUN adduser -D -u 10001 arena && mkdir -p /app/uploads && chown arena /app/uploads
WORKDIR /app
COPY --from=build /out/arena-backend /app/arena-backend
USER arena
ENV GIN_MODE=release PORT=8080
EXPOSE 8080
# Slip images live here - mount a volume so they survive rebuilds.
VOLUME /app/uploads
# SIGTERM: finish requests in progress, then close the database (main.go).
STOPSIGNAL SIGTERM
ENTRYPOINT ["/app/arena-backend"]
