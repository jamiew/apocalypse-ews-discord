# Pinned. Bun ships its own root CAs, so the runtime version is the trust store.
# 1.4.4 drops the compromised eMudhra roots (Oct 2026); bun 1.3.x trusts them.
# Bump deliberately, never below 1.4.4.
FROM oven/bun:1.4.4-debian AS runtime
WORKDIR /app

ENV NODE_ENV=production

COPY package.json bun.lock ./
RUN bun install --production --frozen-lockfile

COPY src ./src
COPY migrations ./migrations
COPY tsconfig.json ./

RUN mkdir -p /app/data
VOLUME ["/app/data"]

ENV DATABASE_PATH=/app/data/ews.db
ENV LOG_FILE=/app/data/ews.log

# Bun reads TypeScript directly — no build step. Source ships in the
# image and the runtime executes it.
CMD ["bun", "run", "src/index.ts"]
