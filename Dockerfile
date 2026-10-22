# Builder stage: better-sqlite3 (via @actual-app/api) may compile with node-gyp, which needs a toolchain
FROM node:22-slim AS builder

# Override to match your Actual server: docker build --build-arg ACTUAL_API_VERSION=<server version> .
ARG ACTUAL_API_VERSION=26.10.0

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
 && if [ "$(node -p "require('./package.json').dependencies['@actual-app/api']")" != "${ACTUAL_API_VERSION}" ]; then \
      npm install --no-save @actual-app/api@${ACTUAL_API_VERSION}; \
    fi \
 && npm cache clean --force

# Runtime stage: no build toolchain, only the installed modules and sources
FROM node:22-slim

WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY src/ ./src/

RUN mkdir -p /data /config && chown node:node /data /config
USER node
VOLUME ["/data"]
ENTRYPOINT ["node", "src/index.js"]
