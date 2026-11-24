# Trot API image. Build from the REPOSITORY ROOT (the API needs packages/domain and db/):
#   docker build -f apps/api/Dockerfile -t trot-api .
#
# The API is TypeScript run directly by tsx, so there is no compile step and no dist folder.

# ---- 1. Production dependencies only (no dev tools, no web app) ----
FROM node:22-slim AS deps
WORKDIR /app
# Every workspace's package.json is needed so the lockfile matches, but only the API's dependencies are installed.
COPY package.json package-lock.json ./
COPY packages/domain/package.json packages/domain/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci --omit=dev --workspace @trot/api

# ---- 2. The image that runs ----
FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
# npm may keep some of the API's packages next to it instead of at the top, so copy both.
COPY --from=deps /app/apps/api/node_modules ./apps/api/node_modules
COPY package.json ./
COPY packages/domain ./packages/domain
COPY apps/api ./apps/api
COPY db ./db
# Uploaded rider documents live here. Mount a persistent volume at this path (see docs/deployment.md), or they are lost when the container is replaced.
RUN mkdir -p /data/uploads && chown node:node /data/uploads
ENV UPLOAD_DIR=/data/uploads
# The built-in "node" user is not root: a flaw in the API cannot write to the image or install anything.
USER node
EXPOSE 3000
# /health answers 200 only when the database is reachable. Settings come from environment variables (see docs/deployment.md).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# Start from the API's own folder: tsx reads tsconfig.json from the working directory, and the API needs the decorator settings in it.
WORKDIR /app/apps/api
CMD ["node", "--import", "tsx", "src/main.ts"]
