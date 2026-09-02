# ==============================================================================
# Production Dockerfile: BlockRun MultiversX AI Gateway & Facilitator
# ==============================================================================

# Build Stage
FROM node:22-alpine AS builder

WORKDIR /app

# Install build tools for native SQLite compilation
RUN apk add --no-cache python3 make g++

COPY package*.json tsconfig.json ./
RUN npm ci

COPY src/ ./src/
RUN npm run build

# Runner Stage
FROM node:22-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV FACILITATOR_PORT=3402

# Install minimal native runtime dependencies
RUN apk add --no-cache dumb-init

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/dist ./dist

# Create persistent data directory for SQLite
RUN mkdir -p /app/data && chown -R node:node /app

USER node

EXPOSE 3000 3402

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/bin/server.js"]
