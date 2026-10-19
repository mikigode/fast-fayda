# Build and runtime are separate stages so the image ships without the
# TypeScript compiler, the test runner, or any of their dependencies.
FROM node:20-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
# Read at startup by the migration runner, so they have to be in the image.
COPY migrations ./migrations
# The card design. Not compiled — it is drawn as-is at runtime — so it has to be
# copied into the runtime stage by hand.
COPY assets ./assets

# Node as PID 1 receives SIGTERM directly, which is what the graceful shutdown
# in server.ts is waiting for. Running it through a shell would swallow it.
USER node
EXPOSE 8080
CMD ["node", "dist/server.js"]
