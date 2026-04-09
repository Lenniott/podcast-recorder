# Podpatch — Local Podcast Recorder

Record lossless audio together, remotely. Audio never leaves your machine.

## How it works

- Host creates an episode (name + password) → gets a shareable URL
- Guest visits the URL, enters the password
- Both choose their microphone and hit **Start Recording**
- Browser writes WAV directly to local disk via File System Access API
- Hitting **👏 Clap** injects a 1kHz sync tone into both recordings simultaneously
- Load both WAVs in any editor, line up the clap spike, done

The server only carries:
- WebSocket presence (who's in the room)
- Clap sync events
- Room metadata (name, password hash) in SQLite

**No audio ever goes to the server.**

---

## Requirements

- **Node.js 22+**
- **Chrome or Edge** (for File System Access API — Firefox does not support it)
- Docker (for home server deployment)

---

## Dev setup

```bash
cp .env.example .env
# Edit .env — set SECRET to something random

npm install
npm run dev
```

Open `http://localhost:5173`

---

## Production (home server with Docker)

```bash
cp .env.example .env
# Edit .env — set a strong SECRET

docker compose up -d --build
```

App runs on port 3000. Put it behind Nginx/Caddy for HTTPS.

### Quick Caddy config

```
your-subdomain.example.com {
    reverse_proxy localhost:3000
}
```

### Quick Nginx config

```nginx
server {
    listen 443 ssl;
    server_name your-subdomain.example.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        # WebSocket support — critical
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
    }
}
```

The `Upgrade` / `Connection` headers are essential — without them WebSocket (presence + clap) won't work.

### Managing rooms in Portainer/Docker

Portainer console often defaults to `bash`, but this image is Alpine-based and only has `sh`.

Use one of these:

```bash
# From host
docker exec -it podcast-recorder sh

# Then inside container
npm run rooms
npm run rooms:delete 1,2,4-6
npm run rooms:delete all
```

Or in Portainer "Container console", change command from `bash` to `sh`.

---

## Resilience

| Scenario | Behaviour |
|---|---|
| Internet drops | Recording continues locally. WS auto-reconnects when back. |
| Mic disconnected | `devicechange` event detected, mic auto-reconnects. Gap in audio, file stays intact. |
| Browser tab crashes | WAV header won't be patched — file is incomplete. See note below. |
| File too large | File System Access API streams directly to disk — no memory limit. |

> **Tab crash recovery:** If the tab crashes mid-recording, the WAV data chunk is written but the header won't reflect the real size. You can recover it with `ffmpeg -i broken.wav -c copy fixed.wav` which re-muxes and fixes the header.

---

## Sync workflow (post-production)

1. Both hosts hit **👏 Clap** at the start (and optionally end) of the session.
2. In your DAW (Reaper, Logic, Audacity, etc.), load both WAV files.
3. Find the spike — it's the 1kHz tone burst, visible as a clear vertical line in the waveform.
4. Align the spikes. Tracks are now in sync.

---

## File structure

```
src/
  lib/server/
    db.js          — SQLite room CRUD
    auth.js        — bcrypt password hashing, HMAC session tokens, slug generation
    ws-rooms.js    — WebSocket room manager (shared by dev + prod servers)
  routes/
    +page.svelte        — Create episode home page
    rec/[slug]/
      +page.svelte      — Recording room UI
      +page.server.js   — Auth, load room data
static/
  worklet/
    recorder-processor.js  — AudioWorklet: PCM capture + clap tone injection
server.js           — Production: SvelteKit + WebSocket on one port
server-ws-dev.js    — Dev: standalone WS server (proxied by Vite)
```
