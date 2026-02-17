# Build context: standalone repo root
# docker build -t jinn-node .
#
# From monorepo: docker build -f jinn-node/Dockerfile jinn-node/

# =============================================================================
# Stage 1: Build
# =============================================================================
FROM node:22-slim AS builder

WORKDIR /app

# Build tools for native modules
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ git \
    && rm -rf /var/lib/apt/lists/*

# Copy manifests and install dependencies
COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile --production=false

# Copy source and build config
COPY src/ ./src/
COPY tsconfig.json tsconfig.build.json ./

# Compile TypeScript + copy JSON assets to dist/
RUN yarn build

# Prune devDependencies so only production deps are copied to runtime
RUN rm -rf node_modules && yarn install --frozen-lockfile --production

# =============================================================================
# Stage 2: Runtime
# =============================================================================
FROM node:22-slim

# Install runtime system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    fonts-liberation \
    git \
    openssh-client \
    dumb-init \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && ln -sf /usr/bin/chromium /usr/bin/chromium-browser

# Pre-install Gemini CLI globally (avoids ~30s npx download per job)
ARG GEMINI_CLI_VERSION=0.25.0
RUN npm install -g @google/gemini-cli@${GEMINI_CLI_VERSION}

# Create non-root user
RUN groupadd -r jinn && useradd -r -g jinn -m -d /home/jinn -s /bin/bash jinn

WORKDIR /app

# Copy built artifacts and dependencies from builder
COPY --from=builder /app/node_modules/ ./node_modules/
COPY --from=builder /app/package.json ./
COPY --from=builder /app/dist/ ./dist/

# Copy init script (used by Railway startCommand and standalone docker run)
COPY scripts/init.sh ./scripts/

# Create directories the worker writes to at runtime.
# IMPORTANT: /tmp/.gemini-worker is used as GEMINI_CLI_HOME (extensions + runtime config).
# Do NOT mount volumes over /tmp — use subdirectory mounts (e.g., /tmp/jinn-telemetry).
RUN mkdir -p /home/jinn/.operate /home/jinn/.gemini /app/jinn-repos /tmp/.gemini-worker \
    && chown -R jinn:jinn /app /tmp/.gemini-worker /home/jinn

# Persistent volume: home dir contains .operate/ (keystore) and .gemini/ (auth + extensions)
VOLUME ["/home/jinn"]

# Cap V8 heap to force earlier GC — without this, Node uses up to ~50% of container
# memory (4GB in 8GB container), inflating baseline RAM. Override at runtime via
# NODE_OPTIONS env var or docker-compose environment section.
ARG NODE_MAX_OLD_SPACE_SIZE=2048

# Environment defaults for containerized operation
ENV NODE_ENV=production \
    GEMINI_SANDBOX=false \
    OPERATE_PROFILE_DIR=/home/jinn/.operate \
    JINN_WORKSPACE_DIR=/app/jinn-repos \
    NODE_OPTIONS="--max-old-space-size=${NODE_MAX_OLD_SPACE_SIZE}"

# Healthcheck endpoint (healthcheck defined in docker-compose.yml)
EXPOSE 8080

# Run as non-root
USER jinn

# dumb-init as PID 1 for proper signal forwarding
# worker_launcher.js handles SIGTERM/SIGINT propagation to child processes
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/worker/worker_launcher.js"]
