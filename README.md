# Home Recor — Local Podcast Recorder

Record great-quality audio together, even when you're in different places. Every recording is saved straight to each person's own computer — nothing gets uploaded anywhere.

## How it works

- The host creates an episode (gives it a name and a password) and gets a link to share.
- The guest opens that link and enters the password.
- Both people pick their microphone and press **Start Recording**.
- Right after that, each person reads a line of text out loud and hits Listen. This plays back exactly what got saved, so you both know your recording is working before you really get going.
- Your browser saves the audio straight to your own hard drive as a WAV file. The waveform on screen shows what's actually been saved — not just what your mic is picking up — so you'd notice right away if something went wrong.
- Press **👏 Clap** at any point to mark the same moment in both recordings. This makes it easy to line them up later.
- When you're done, open both WAV files in any audio editor, find the clap, and line them up. Now both recordings play in sync.
- **Shared tabs**: everyone in the room sees the same set of tabs. Opening, closing, or switching a tab changes it for everyone. Paste a YouTube link into a tab and it plays in sync for both people — wear headphones, since the video's own sound plays in each browser but is never mixed into your recording. Each tab also has a shared notes box underneath it that anyone can type in.
- Hold **Talk** (it appears once a video is playing) to turn down your own video's volume while you talk.

The server never sees or stores your audio. All it handles is:
- Who's currently in the room
- The Clap sync signal
- The shared tabs — which ones exist, what video is in each, and the shared notes (never the video itself)
- Basic room details (its name and a password hash), kept in a small local database

**Your audio never touches the server.**

---

## Requirements

- **Node.js 22 or newer**
- **Chrome or Edge** — recording relies on a browser feature called the File System Access API, which Firefox doesn't support yet.
- **Docker**, if you want to host this on your own server.

---

## Dev setup

```bash
cp .env.example .env
# Open .env and set SECRET to any random string

npm install
npm run dev
```

Open `http://localhost:5173`

---

## Tests

```bash
npm test                 # unit tests (Vitest)
npm run test:coverage    # same, plus a coverage/ HTML report
npm run test:e2e         # Playwright (needs .env with SECRET)
```

---

## Production (hosting it on your own server)

Clone the repo — Docker Compose needs to build the image from this repo's Dockerfile, so just pointing it at a compose file on its own isn't enough:

```bash
git clone https://github.com/Lenniott/podcast-recorder.git
cd podcast-recorder
cp .env.example .env
# Set SECRET — this is required. SITE_PASSWORD is optional; set it if you
# want to lock the "create episode" page behind a password.
# Behind HTTPS, also set HTTPS=true (and FORCE_HTTPS=true if your reverse
# proxy is the one handling HTTPS). ROOM_MAX_AGE_HOURS controls how long
# rooms remain available; it defaults to 12.

chmod +x update.sh
docker compose up -d --build
```

This runs the app on port **7799** on your server (it maps to port 3000 inside the container — see `docker-compose.yml`). Open `http://<your-server>:7799` to check it's up. Your rooms are stored in a Docker volume called `podcast-recorder-data`. Your `.env` file stays on your server only — it's never tracked by git.

### Updating after you push new changes

On your own computer: commit your changes and push to `main`.

On the server, from this folder:

```bash
sudo ./update.sh
```

This pulls the latest code, rebuilds and restarts the container, then shows you the running containers and the last 20 lines of logs. (Running `./update.sh` without `sudo` also works — it'll ask for permission itself if it needs it.)

If the server has its own local changes that would conflict, the update stops on purpose rather than overwriting them. Undo those changes on the server, or save them somewhere else, then try again.

Rebuilding never deletes your rooms. The one command to avoid is `docker compose down -v` — that's the one that wipes your data.

To double-check everything's working:

```bash
docker compose ps
docker compose logs --tail 20 podcast-recorder
curl -sI http://127.0.0.1:7799/ | head -1
```

You're looking for: the container listed as **Up**, a log line saying `listening on http://0.0.0.0:3000` and `SECRET = ✓ set`, and a response of `HTTP/1.1 200 OK`.

To make this reachable over HTTPS, put it behind a reverse proxy like Nginx or Caddy, pointing at port **7799** (not 3000).

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

The `Upgrade` and `Connection` headers are required — without them, the live features (who's online, Clap, and shared YouTube playback) won't work.

### Managing rooms in Portainer or Docker

Portainer's console often defaults to `bash`, but this image is built on Alpine Linux, which only has `sh`. Use one of these instead:

```bash
# From your host machine
docker exec -it podcast-recorder sh

# Then inside the container
npm run rooms
npm run rooms:delete 1,2,4-6
npm run rooms:delete all
```

Or in Portainer's "Container console", just switch the command from `bash` to `sh`.

---

## What happens when things go wrong

| If this happens | Here's what you can expect |
|---|---|
| Your internet drops | Recording keeps going on your own computer the whole time. Once you're back online, the connection reconnects on its own, and both people's "Recording" status shows correctly again — it won't get stuck showing the wrong thing. |
| Your hard drive is slow to keep up | The app just waits for your disk to catch up — it never fills the gap with fake silence. Your recording stays complete and in the right order. |
| Your microphone gets unplugged | The app notices right away and switches to another available mic automatically. You'll get a short gap in that spot, but the rest of the file is untouched. |
| Your browser tab crashes | The audio that was already saved is fine, but the file's header (the part that says how long the file is) won't get updated, so some players will call it "broken." See the fix below. |
| Your recording runs very long | No problem — the file is written straight to your hard drive as you go, so there's no memory limit to run into. |

> **Fixing a file after a tab crash:** if your browser tab crashes mid-recording, your audio is safe, but the file's header wasn't updated with the final size. Fix it with `ffmpeg -i broken.wav -c copy fixed.wav` — this rewrites the header without touching your audio.

---

## Lining up two recordings after you're done

1. Both people should hit **👏 Clap** once at the start of the session (and again at the end, if you like).
2. Open both WAV files in your editing software — Reaper, Logic, Audacity, whatever you use.
3. Look for the clap — it shows up as a sharp spike in the waveform.
4. Line up the two spikes. Your recordings are now in sync.
