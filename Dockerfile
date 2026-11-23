# syntax=docker/dockerfile:1
# One image: the Go API with the built web app embedded (ADR-083).
# Build from the repo root: docker build -t factual .
# Running it: deploy/docker-compose.yml and docs/DEPLOYMENT.md.

# --- web app: static SPA in apps/web/dist/client ---
FROM node:24-alpine AS web
# Keep in step with packageManager in package.json.
RUN npm install -g pnpm@12.15.0
WORKDIR /src
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile --filter web
COPY apps/web apps/web
RUN pnpm --filter web build

# --- API binary with the web app embedded ---
# Keep in step with the go line in apps/api/go.mod.
FROM golang:1.27.2-alpine AS api
WORKDIR /src/apps/api
ENV CGO_ENABLED=0
COPY apps/api/go.mod apps/api/go.sum ./
RUN go mod download
COPY apps/api ./
COPY --from=web /src/apps/web/dist/client internal/webui/static/
ARG VERSION=dev
RUN go build -trimpath -ldflags="-s -w -X main.version=${VERSION}" -o /out/factual ./cmd/api

# --- runtime: no shell; CA certificates (OIDC) and time zones included ---
FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=api /out/factual /factual
ENV FACTUAL_HTTP_ADDR=:8080
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 CMD ["/factual", "healthcheck"]
ENTRYPOINT ["/factual"]
