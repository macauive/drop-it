FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --include=dev
COPY tsconfig.json vite.config.ts ./
COPY scripts/inline-widget.ts ./scripts/inline-widget.ts
COPY server ./server
COPY shared ./shared
COPY web ./web
COPY release/review/walkthrough-2026-10-03.mp4 release/review/walkthrough-0.1.1-2026-10-16.mp4 ./release/review/
RUN npm run build

FROM node:24-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app /app
USER node
EXPOSE 4317
CMD ["node", "--import", "tsx", "server/index.ts"]
