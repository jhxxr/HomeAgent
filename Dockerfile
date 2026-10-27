FROM node:26.12.1-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json .npmrc ./
RUN npm ci
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:26.12.1-bookworm-slim AS relay
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3210 HOMEAGENT_DB=/app/data/server.sqlite
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY LICENSE THIRD_PARTY_NOTICES.md ./
COPY licenses ./licenses
COPY public ./public
COPY runtime ./runtime
RUN mkdir /app/data && chown node:node /app/data
USER node
EXPOSE 3210
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s CMD node -e "fetch('http://127.0.0.1:3210/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "dist/server/cli.js"]

FROM node:26.12.1-bookworm-slim AS runner
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist/runner ./dist/runner
COPY --from=build /app/dist/shared ./dist/shared
COPY bin/runner.mjs ./bin/runner.mjs
COPY runtime ./runtime
USER root
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
RUN mkdir /state /workspace /config && chown node:node /state /workspace
USER node
HEALTHCHECK NONE
ENTRYPOINT ["node", "bin/runner.mjs"]
CMD ["run", "--config", "/config/runner.json"]
