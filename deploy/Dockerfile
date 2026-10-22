# syntax=docker/dockerfile:1
FROM node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df AS base
WORKDIR /app
RUN npm install --global npm@11.21.1
COPY package.json package-lock.json ./
COPY packages/config/package.json packages/config/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/chess/package.json packages/chess/package.json
COPY packages/database/package.json packages/database/package.json
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json

FROM base AS build
RUN npm ci
COPY packages packages
COPY apps apps
COPY tsconfig.json ./
COPY LICENSE README.md THIRD_PARTY_NOTICES.md .env.example .nvmrc ./
COPY docs/licensing.md docs/development.md ./docs/
ARG VITE_API_BASE_URL
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL
ENV SANDBOX_ENABLED=false
RUN node --input-type=module -e "import { parseWebEnvironment } from './apps/web/src/app/env.ts'; const env = parseWebEnvironment(process.env); if (!env.VITE_API_BASE_URL.startsWith('https://')) throw new Error('INVALID_PRODUCTION_API_ORIGIN');" && npm run build

FROM base AS runtime-dependencies
RUN npm ci --omit=dev --workspace @neurochess/api --workspace @neurochess/database --workspace @neurochess/chess --workspace @neurochess/contracts --ignore-scripts

FROM node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df AS api
WORKDIR /app
ENV NODE_ENV=production API_HOST=0.0.0.0 API_PORT=3001 SANDBOX_ENABLED=false
COPY --from=runtime-dependencies /app/node_modules ./node_modules
COPY --from=runtime-dependencies /app/package.json ./package.json
COPY --from=build /app/LICENSE /app/THIRD_PARTY_NOTICES.md ./
COPY --from=runtime-dependencies /app/apps/api/package.json ./apps/api/package.json
COPY --from=runtime-dependencies /app/packages/contracts/package.json ./packages/contracts/package.json
COPY --from=runtime-dependencies /app/packages/chess/package.json ./packages/chess/package.json
COPY --from=runtime-dependencies /app/packages/database/package.json ./packages/database/package.json
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/packages/contracts/dist ./packages/contracts/dist
COPY --from=build /app/packages/chess/dist ./packages/chess/dist
COPY --from=build /app/packages/database/dist ./packages/database/dist
COPY --from=build /app/packages/database/drizzle ./packages/database/drizzle
USER node
EXPOSE 3001
CMD ["node", "apps/api/dist/server.js"]

FROM caddy:2.11.7-alpine@sha256:d8542f48d34a9cf4e4c11a478865229840e87e4c96ea3f439101f31a5d35f75f AS web
COPY --from=build /app/apps/web/dist /srv
COPY deploy/Caddyfile /etc/caddy/Caddyfile
