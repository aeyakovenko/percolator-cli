# Oracle keeper worker. It exposes no inbound HTTP service.
FROM node:22-slim

ARG NINJA_RELEASE_SOURCE=local
ARG NINJA_RELEASE_ID=local
ENV NINJA_RELEASE_SOURCE=$NINJA_RELEASE_SOURCE
ENV NINJA_RELEASE_ID=$NINJA_RELEASE_ID

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN corepack enable \
  && pnpm install --frozen-lockfile --prod=false

COPY src ./src
COPY scripts ./scripts
COPY tsconfig.json tsconfig.*.json ./

# Node remains PID 1 so stop/restart signals reach the keeper cancellation
# handlers directly.
ENV NODE_ENV=production
CMD ["node", "--import", "tsx", "scripts/oracle-keeper-v16.ts"]
