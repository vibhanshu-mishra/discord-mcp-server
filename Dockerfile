# syntax=docker/dockerfile:1
# Multi-stage build: compile in the builder, ship only production deps + dist.

# ── Stage 1: Build ──
FROM node:26-alpine AS builder
WORKDIR /app
COPY package*.json tsconfig.json ./
RUN npm ci
COPY src/ src/
RUN npm run build

# ── Stage 2: Runtime ──
FROM node:26-alpine

LABEL org.opencontainers.image.title="Discord MCP Server"
LABEL org.opencontainers.image.description="A lightweight, multi-guild Discord MCP server with private local analytics."
LABEL org.opencontainers.image.licenses="MIT"

WORKDIR /app
COPY package*.json ./
# Install only production dependencies, create a non-root user, and provide a
# writable data directory for the analytics database.
RUN npm ci --omit=dev && npm cache clean --force && \
    addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001 && \
    mkdir -p /app/data && chown -R nodejs:nodejs /app

# Copy only the compiled output — never .env, databases, backups, exports, or tests.
COPY --from=builder /app/dist/ dist/

USER nodejs
ENV NODE_ENV=production
# Persist the analytics database on a mounted volume.
VOLUME ["/app/data"]

# Health check runs the OFFLINE doctor (no Discord connection, no token needed).
HEALTHCHECK --interval=1m --timeout=15s --start-period=10s --retries=3 \
    CMD ["node", "dist/cli/index.js", "doctor"]

# Default entry point is the MCP server (stdio). Override the command to run a CLI
# operation, e.g. `docker run ... node dist/cli/index.js db-check`.
ENTRYPOINT ["node", "dist/index.js"]
