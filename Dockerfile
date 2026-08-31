# Build
FROM node:22-alpine AS build
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Runtime: production dependencies only, no toolchain, no source.
FROM node:22-alpine
WORKDIR /app

RUN apk add --no-cache tini

COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY README.md SKILL.md LICENSE ./

# `mastodon-mcp login` writes the account store here. Mount a volume on it so a
# token survives a restart, or pass MASTODON_ACCESS_TOKEN instead.
ENV MASTODON_MCP_HOME=/data
RUN mkdir -p /data && chown node:node /data
VOLUME /data

USER node

# tini reaps zombies and forwards signals, so `docker stop` returns promptly
# rather than waiting out the grace period.
ENTRYPOINT ["/sbin/tini", "--", "node", "dist/index.js"]
