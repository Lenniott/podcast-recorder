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
# server.js loads this graph as real files (not through Vite's bundle).
# Copy the complete tree so sibling imports from ws-rooms.js — research,
# room, home, recording, and future modules — cannot drift out of the image.
COPY --from=builder /app/src/lib       ./src/lib
COPY --from=builder /app/scripts       ./scripts

COPY --from=builder /app/package.json  ./package.json

# Persist database outside the container
VOLUME ["/app/data"]

ENV NODE_ENV=production
ENV PORT=3000
ENV DB_PATH=/app/data/rooms.db
ENV ROOM_MAX_AGE_HOURS=12

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
