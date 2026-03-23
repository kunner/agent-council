FROM node:20-alpine AS builder
WORKDIR /app
RUN npm i -g pnpm

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/server/package.json ./packages/server/
RUN pnpm install --frozen-lockfile

COPY tsconfig.base.json ./
COPY packages/shared ./packages/shared
COPY packages/server ./packages/server
RUN pnpm --filter @agent-council/shared build && pnpm --filter @agent-council/server build

FROM node:20-alpine
RUN npm i -g pnpm @anthropic-ai/claude-code
WORKDIR /app

COPY --from=builder /app/pnpm-workspace.yaml /app/pnpm-lock.yaml /app/package.json ./
COPY --from=builder /app/packages/shared/package.json ./packages/shared/
COPY --from=builder /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder /app/packages/server/package.json ./packages/server/
COPY --from=builder /app/packages/server/dist ./packages/server/dist
RUN pnpm install --frozen-lockfile --prod

EXPOSE 3001
CMD ["node", "packages/server/dist/index.js"]
