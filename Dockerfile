FROM node:22-bookworm-slim AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-bookworm-slim AS runtime

RUN groupadd --system mmf \
    && useradd --system --gid mmf --create-home --home-dir /home/mmf mmf

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund \
    && npm cache clean --force
COPY --from=build --chown=mmf:mmf /app/dist ./dist

RUN mkdir -p /data && chown mmf:mmf /data

ENV NODE_ENV=production
ENV MMF_DATA_DIR=/data
ENV MMF_HOST=0.0.0.0

VOLUME ["/data"]
EXPOSE 8787
USER mmf

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.MMF_PORT || '8787') + '/healthz').then((response) => { if (!response.ok) process.exit(1); }).catch(() => process.exit(1))"]

ENTRYPOINT ["node", "/app/dist/cli.js"]
CMD ["hub"]
