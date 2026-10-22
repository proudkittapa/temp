# The website: the React app built for the real backend (API mode), served
# by Caddy, which also forwards /api to the backend and gets the HTTPS
# certificate. Build context: the repository root.
FROM node:22-alpine AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci
COPY index.html vite.config.ts tsconfig.json ./
COPY src ./src
ENV VITE_DATA_SOURCE=api
RUN npm run build

FROM caddy:2-alpine
COPY deploy/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /src/dist /srv
