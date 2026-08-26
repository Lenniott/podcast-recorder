FROM node:22-alpine AS builder

WORKDIR /app
COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

# ── Production image ──────────────────────────────────────────────────
FROM node:22-alpine

WORKDIR /app

# Only copy what's needed to run
COPY --from=builder /app/build         ./build
COPY --from=builder /app/node_modules  ./node_modules
COPY --from=builder /app/server.js     ./server.js
COPY --from=builder /app/src/lib/server ./src/lib/server
# server.js loads these as real files (not bundled). Copy every top-level
# lib JS so a new import from ws-rooms.js cannot crash the image.
COPY --from=builder /app/src/lib/*.js ./src/lib/
COPY --from=builder /app/scripts       ./scripts

COPY --from=builder /app/package.json  ./package.json

# Persist database outside the container
VOLUME ["/app/data"]

ENV NODE_ENV=production
ENV PORT=3000
ENV DB_PATH=/app/data/rooms.db
ENV ROOM_MAX_AGE_HOURS=12

EXPOSE 3000

CMD ["node", "server.js"]
