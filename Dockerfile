FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --frozen-lockfile || pnpm install
COPY tsconfig.json ./
COPY src ./src
COPY migrations ./migrations
RUN pnpm build

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN corepack enable
COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --prod --frozen-lockfile || pnpm install --prod
COPY --from=build /app/dist ./dist
COPY migrations ./migrations
RUN mkdir -p /app/data
VOLUME ["/app/data"]
ENV DATABASE_PATH=/app/data/ews.db
CMD ["node", "dist/index.js"]
