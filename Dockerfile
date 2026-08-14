# syntax=docker/dockerfile:1

# ---- build: compile src/ -> dist/, sw.js -----------------------------------
# TypeScript is a build-time dependency only (see README § Architecture), so
# this stage is the only one that ever needs `npm ci`.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig*.json ./
COPY src ./src
COPY tools ./tools
RUN npm run build

# ---- runtime: zero npm dependencies -----------------------------------------
# server/*.ts run directly under Node's built-in type stripping, exactly like
# the build tools do — no node_modules, no TypeScript, at runtime. The only
# thing added on top of the base image is the `sqlite3` CLI, an OS package
# (not a JS dependency) purely for ad hoc inspection/backup of the database —
# see README § Self-hosting.
FROM node:22-alpine AS runtime
WORKDIR /app
RUN apk add --no-cache sqlite
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=4173
ENV DATA_DIR=/app/data

COPY --from=build /app/dist ./dist
COPY --from=build /app/sw.js ./sw.js
COPY index.html manifest.webmanifest ./
COPY assets ./assets
COPY styles ./styles
COPY server ./server

# The `node` user/group ship in the base image; only the data directory needs
# to be writable by it.
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node

EXPOSE 4173
VOLUME ["/app/data"]

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4173)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.ts"]
