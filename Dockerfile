FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev && npm install --no-save tsx
COPY --from=build /app/dist ./dist
COPY migrations ./migrations
COPY docs ./docs
COPY scripts ./scripts
COPY src ./src
USER node
EXPOSE 3000
CMD ["sh", "-c", "npx tsx scripts/migrate.ts && node dist/server.js"]
