# Podpatch — Local Podcast Recorder

Record lossless audio together, remotely. Audio never leaves your machine.

## How it works

- Host creates an episode (name + password) → gets a shareable URL
- Guest visits the URL, enters the password
- Both choose their microphone and hit **Start Recording**
- Browser writes WAV directly to local disk via File System Access API
- Hitting **👏 Clap** injects a 1kHz sync tone into both recordings simultaneously
- Load both WAVs in any editor, line up the clap spike, done
- **Shared tabs**: host and guest can both open tabs in a shared view — switching, adding, or closing a tab changes it for everyone. Each tab can hold a synced YouTube clip (paste a link — playback stays in sync for both; wear headphones, since the video's audio plays in each browser and is never mixed into the WAV) and always has a shared plain-text notes area underneath it, editable by both, with no save state.
- Hold **Talk** (shown once a tab's video is playing) to duck your local video volume while you speak.

The server only carries:
- WebSocket presence (who's in the room)
- Clap sync events
- Shared tab state (tab list, each tab's YouTube video id + position, and its shared text — never the video itself)
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

Clone the repo (compose builds from this Dockerfile; a compose-file URL is not enough):

```bash
git clone https://github.com/Lenniott/podcast-recorder.git
cd podcast-recorder
cp .env.example .env
# Set SECRET (required). SITE_PASSWORD is optional (locks the create-episode page).
# Behind TLS, set HTTPS=true (and FORCE_HTTPS=true if the proxy terminates TLS).

chmod +x update.sh
docker compose up -d --build
```

Compose publishes **7799** on the host (`7799:3000` in `docker-compose.yml`). Open `http://<host>:7799`. SQLite lives in the `podcast-recorder-data` volume; `.env` is local and gitignored.

### Updating after you push

On the laptop: commit and push to `main`.

On the server, from this directory:

```bash
sudo ./update.sh
```

That `git pull --ff-only`s, then `docker compose up -d --build`, then prints `ps` and the last 20 log lines. `./update.sh` also works; the script sudo's docker if you're not root.

`--ff-only` refuses to pull if the server has local commits or a dirty merge. Stash or discard server-side edits, or the pull stops on purpose.

Rooms survive the rebuild. Never `docker compose down -v` (that deletes the volume).

Sanity check:

```bash
docker compose ps
docker compose logs --tail 20 podcast-recorder
curl -sI http://127.0.0.1:7799/ | head -1
```

You want the container **Up**, logs showing `listening on http://0.0.0.0:3000` and `SECRET = ✓ set`, and `HTTP/1.1 200 OK`.

Put it behind Nginx/Caddy for HTTPS. Proxy to **7799**, not 3000.

### Quick Caddy config

```
your-subdomain.example.com {
    reverse_proxy localhost:7799
}
```

### Quick Nginx config

```nginx
server {
    listen 443 ssl;
    server_name your-subdomain.example.com;

    location / {
        proxy_pass http://localhost:7799;
        proxy_http_version 1.1;
        # WebSocket support — critical
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
    }
}
```

The `Upgrade` / `Connection` headers are essential — without them WebSocket (presence, clap, and shared YouTube state) won't work.

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
  lib/
    RoomSidebar.svelte     — Composes the left sidebar's four panels
    RoomDetailsPanel.svelte, MicPanel.svelte, WaveformPanel.svelte,
    RecordControls.svelte  — Presentational sidebar panels (state stays in +page.svelte)
    RoomTabs.svelte         — Shared tab strip + active tab's video/text content
    TabVideoPlayer.svelte   — Synced YouTube panel for one tab (IFrame API + controls)
    tab-sync.js             — MAX_TABS/MAX_TAB_TEXT_LEN/nextTabTitle (shared client+server)
    yt-sync.js              — parseYouTubeId + effectivePosition helpers
    server/
      db.js          — SQLite room CRUD
      auth.js        — bcrypt password hashing, HMAC session tokens, slug generation
      ws-rooms.js    — WebSocket room manager (presence, clap, tabs_state/tab_video/tab_text)
  routes/
    +page.svelte        — Create episode home page
    rec/[slug]/
      +page.svelte      — Recording room UI (wires clockOffset into RoomTabs)
      +page.server.js   — Auth, load room data
static/
  worklet/
    recorder-processor.js  — AudioWorklet: PCM capture + clap tone injection
server.js           — Production: SvelteKit + WebSocket on one port
server-ws-dev.js    — Dev: standalone WS server (proxied by Vite)
```
