# Trot web portal image: the built site served by nginx. Build from the REPOSITORY ROOT:
#   docker build -f apps/web/Dockerfile --build-arg VITE_API_URL=https://api.example.com -t trot-web .
# VITE_API_URL is baked into the site when it is built, so it is required. It must be the address people's browsers use to reach the API.

# ---- 1. Build the site ----
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/domain/package.json packages/domain/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci --workspace @trot/web
COPY apps/web ./apps/web
ARG VITE_API_URL
RUN test -n "$VITE_API_URL" || (echo "ERROR: set --build-arg VITE_API_URL=https://your-api-address (without it the site would call http://localhost:3000)" >&2; exit 1)
ENV VITE_API_URL=$VITE_API_URL
RUN npm --workspace @trot/web run build

# ---- 2. Serve it ----
# The "unprivileged" nginx runs as a normal user and listens on 8080.
FROM nginxinc/nginx-unprivileged:1.27-alpine
ARG VITE_API_URL
# The same address, as the one place the browser is allowed to call (see the Content-Security-Policy in the nginx template).
ENV API_ORIGIN=$VITE_API_URL
COPY apps/web/nginx/default.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
