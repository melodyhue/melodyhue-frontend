# ---- Build Stage ----
FROM node:22-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build:prod

# ---- Runtime Stage ----
FROM node:22-alpine AS runner

ENV NODE_ENV=production \
    PORT=3000

WORKDIR /app

COPY --from=builder /app/dist ./dist

EXPOSE 3000

CMD ["node", "dist/melodyhue-frontend/server/server.mjs"]
