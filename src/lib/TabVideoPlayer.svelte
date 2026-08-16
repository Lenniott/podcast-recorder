<script>
  import { onDestroy, tick } from "svelte";
  import { parseYouTubeId, effectivePosition } from "./yt-sync.js";

  // Scopes every outgoing message to this tab. The parent (RoomTabs) owns
  // which tab is active and destroys/recreates this component on switch, so
  // exactly one player/audio-stream is ever live at a time.
  export let tabId;
  export let send = () => {}; // (payload) => void — JSON-sends over the room WS
  export let clockOffset = 0; // serverTime - clientTime, from the page's clock sync

  // Room-wide hold-to-talk duck, owned by the parent (talk isn't per-tab).
  export let talking = false; // true while *this* browser is holding Talk
  export let roomTalking = false; // true while any peer (including us) is holding Talk

  const SEEK_TOLERANCE_SEC = 0.75;
  const DRIFT_CHECK_MS = 20000;
  const DUCK_FACTOR = 0.25;

  let container;
  let player = null;
  let playerReady = false;
  let loadedVideoId = null; // what the player currently has cued

  let sharedState = null; // last tab_video received for this tab (null = no video)
  let applySeq = 0; // stale-timeout guard: only the latest state applies

  let inputUrl = "";
  let inputError = "";

  // UI mirrors of the player, refreshed on a light interval
  let playing = false;
  let currentSec = 0;
  let durationSec = 0;
  let scrubbing = false;
  let scrubSec = 0;
  let uiTimer = null;
  let driftTimer = null;

  // Slider and mute stay local; the room-wide Talk duck (above) scales it.
  let volume = 100;
  let muted = false;

  $: effectiveVolume = talking || roomTalking ? Math.round(volume * DUCK_FACTOR) : volume;
  $: if (playerReady && player && Number.isFinite(effectiveVolume)) player.setVolume(effectiveVolume);
  $: if (playerReady && player) muted ? player.mute() : player.unMute();

  // ── Shared state in — the component's single entry point, driven by the
  //    parent's inbound `tab_video` messages for this tab ─────────────────

  export function applyState(msg) {
    const seq = ++applySeq;

    // Only an explicit empty id is a clear. Ignore malformed payloads so
    // they can't unmount the player.
    if (msg.videoId === "") {
      sharedState = null;
      clearPlayer();
      return;
    }
    if (!msg.videoId) return;

    sharedState = msg;
    const delayMs = Math.max(0, msg.triggerAtMs - (Date.now() + clockOffset));
    setTimeout(() => {
      if (seq === applySeq) reconcile(msg);
    }, delayMs);
  }

  /** Make the player match the shared state right now. Idempotent. */
  async function reconcile(msg) {
    await ensurePlayer(msg.videoId);
    if (!player || !playerReady) return;

    // Player creation is async — a newer state may have arrived while we
    // waited, so always converge on the latest one.
    const s = sharedState || msg;
    const target = effectivePosition(s, Date.now() + clockOffset);

    if (loadedVideoId !== s.videoId) {
      // startSeconds folds the seek into the load — a seekTo right after
      // cueVideoById gets swallowed while the video is still cueing.
      if (s.playing) player.loadVideoById(s.videoId, target);
      else player.cueVideoById(s.videoId, target);
      loadedVideoId = s.videoId;
      playing = s.playing;
      return;
    }

    if (Math.abs(player.getCurrentTime() - target) > SEEK_TOLERANCE_SEC) {
      player.seekTo(target, true);
    }
    if (s.playing) player.playVideo();
    else player.pauseVideo();
    playing = s.playing;
  }

  // Clicking the shield re-applies the shared state. This is both a manual
  // re-sync and the escape hatch when the browser blocks autoplay until the
  // user interacts with the page.
  function resync() {
    if (sharedState) reconcile(sharedState);
  }

  // ── YouTube IFrame API plumbing ────────────────────────────────────

  let apiPromise = null;

  function loadIframeApi() {
    if (window.YT?.Player) return Promise.resolve();
    if (apiPromise) return apiPromise;
    apiPromise = new Promise((resolve) => {
      const prev = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => {
        prev?.();
        resolve();
      };
      const tag = document.createElement("script");
      tag.src = "https://www.youtube.com/iframe_api";
      document.head.appendChild(tag);
    });
    return apiPromise;
  }

  function ensurePlayer(videoId) {
    if (player) return Promise.resolve();
    return loadIframeApi()
      .then(() => tick())
      .then(
        () =>
          new Promise((resolve) => {
            if (player) return resolve();
            if (!container) return resolve();
            // YT.Player replaces its target node. Use a child Svelte doesn't
            // own, otherwise the next reactive update (volume) puts the
            // empty div back and the iframe vanishes.
            const target = document.createElement("div");
            target.style.width = "100%";
            target.style.height = "100%";
            container.replaceChildren(target);
            player = new window.YT.Player(target, {
              videoId,
              width: "100%",
              height: "100%",
              // No native controls — every action goes through room controls
              // so both players stay on the server's timeline.
              playerVars: {
                controls: 0,
                disablekb: 1,
                rel: 0,
                modestbranding: 1,
                origin: window.location.origin,
              },
              events: {
                onReady: () => {
                  playerReady = true;
                  loadedVideoId = videoId;
                  const v = player.getVolume();
                  volume = Number.isFinite(v) ? v : 100;
                  muted = !!player.isMuted();
                  startUiTimer();
                  startDriftTimer();
                  resolve();
                },
              },
            });
          }),
      );
  }

  function clearPlayer() {
    stopUiTimer();
    stopDriftTimer();
    player?.destroy();
    player = null;
    playerReady = false;
    loadedVideoId = null;
    playing = false;
    currentSec = 0;
    durationSec = 0;
  }

  function startUiTimer() {
    stopUiTimer();
    uiTimer = setInterval(() => {
      if (!playerReady) return;
      if (!scrubbing) currentSec = player.getCurrentTime() || 0;
      durationSec = player.getDuration() || 0;
    }, 500);
  }

  function stopUiTimer() {
    clearInterval(uiTimer);
    uiTimer = null;
  }

  // Periodically re-align this browser's player with the shared state even
  // without a fresh command, so drift (and the echo it can cause) can't
  // silently build up between manual "resync" clicks.
  function startDriftTimer() {
    stopDriftTimer();
    driftTimer = setInterval(() => {
      if (!playerReady || !sharedState) return;
      const target = effectivePosition(sharedState, Date.now() + clockOffset);
      if (Math.abs(player.getCurrentTime() - target) > SEEK_TOLERANCE_SEC) {
        reconcile(sharedState);
      }
    }, DRIFT_CHECK_MS);
  }

  function stopDriftTimer() {
    clearInterval(driftTimer);
    driftTimer = null;
  }

  onDestroy(clearPlayer);

  // ── Controls out (always send full desired state) ──────────────────
  // Load/clear/control are all symmetric — any peer may do any of them.

  function loadVideo() {
    const id = parseYouTubeId(inputUrl);
    if (!id) {
      inputError = "Could not find a YouTube video in that link.";
      return;
    }
    inputError = "";
    inputUrl = "";
    send({ type: "tab_video", tabId, action: "load", videoId: id, playing: false, positionSec: 0 });
  }

  function togglePlay() {
    if (!sharedState) return;
    send({
      type: "tab_video",
      tabId,
      action: "control",
      videoId: sharedState.videoId,
      playing: !playing,
      positionSec: playerReady ? player.getCurrentTime() : 0,
    });
  }

  function scrub() {
    scrubbing = false;
    if (!sharedState) return;
    send({
      type: "tab_video",
      tabId,
      action: "control",
      videoId: sharedState.videoId,
      playing,
      positionSec: scrubSec,
    });
  }

  function clearVideo() {
    send({ type: "tab_video", tabId, action: "clear", videoId: "", playing: false, positionSec: 0 });
  }

  function toggleMute() {
    muted = !muted;
  }

  function fmt(sec) {
    const s = Math.max(0, Math.floor(sec));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  }
</script>

<div class="watch-card">
  {#if sharedState}
    <div class="watch-header">
      <button type="button" class="watch-clear" on:click={clearVideo}>Clear video</button>
    </div>

    <div class="headphones-banner">
      🎧 Use headphones — YouTube audio plays in each browser and can bleed into
      your mic if speakers are on.
    </div>

    <div class="watch-player">
      <div class="watch-player-target" bind:this={container}></div>
      <!-- Swallows clicks so nobody play/pauses outside the sync protocol;
           a click re-applies shared state (fixes autoplay-blocked guests). -->
      <button
        type="button"
        class="watch-shield"
        on:click={resync}
        title="Click to re-sync with the room"
        aria-label="Re-sync video"
      ></button>
    </div>

    <div class="watch-controls">
      <slot name="controls-left" />
      <button type="button" class="watch-play-btn" on:click={togglePlay}>
        {playing ? "⏸ Pause" : "▶ Play"}
      </button>
      <span class="watch-time"
        >{fmt(scrubbing ? scrubSec : currentSec)} / {fmt(durationSec)}</span
      >
      <input
        type="range"
        class="watch-scrubber"
        min="0"
        max={durationSec || 0}
        step="1"
        value={scrubbing ? scrubSec : currentSec}
        on:input={(e) => {
          scrubbing = true;
          scrubSec = +e.currentTarget.value;
        }}
        on:change={scrub}
        disabled={!playerReady}
      />
    </div>

    <div class="watch-volume-row">
      <button
        type="button"
        class="watch-mute-btn"
        on:click={toggleMute}
        title={muted ? "Unmute" : "Mute"}
        aria-label={muted ? "Unmute" : "Mute"}
      >
        {muted ? "🔇" : "🔊"}
      </button>
      <input
        type="range"
        class="watch-volume-slider"
        min="0"
        max="100"
        step="1"
        bind:value={volume}
        title="Your local video volume"
      />
    </div>
  {:else}
    <div class="watch-load-row">
      <input
        type="text"
        placeholder="Paste a YouTube link or video id"
        bind:value={inputUrl}
        on:keydown={(e) => e.key === "Enter" && loadVideo()}
      />
      <button type="button" class="btn-primary watch-load-btn" on:click={loadVideo}>Watch</button>
    </div>
    {#if inputError}
      <p class="watch-error">{inputError}</p>
    {/if}
  {/if}
</div>

<style>
  .watch-card {
    padding: 16px;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 10px;
  }

  .watch-header {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    margin-bottom: 10px;
  }

  .watch-clear {
    font-size: 12px;
    padding: 4px 10px;
    border-radius: 6px;
    border: 1px solid var(--border);
    background: transparent;
    color: var(--muted);
    cursor: pointer;
  }
  .watch-clear:hover {
    background: var(--border);
    color: var(--text);
  }

  .watch-load-row {
    display: flex;
    gap: 8px;
  }
  .watch-load-row input {
    display: flex;
    width: 100%;
  }
  .watch-load-row input:focus {
    outline: none;
    border-color: var(--accent);
  }
  .watch-load-btn {
    white-space: nowrap;
    width: 100px;
  }

  .watch-error {
    color: #e5484d;
    font-size: 12px;
    margin: 6px 0 0;
  }

  .headphones-banner {
    margin-bottom: 12px;
    padding: 10px 12px;
    border-radius: 8px;
    background: rgba(245, 158, 11, 0.1);
    border: 1px solid rgba(245, 158, 11, 0.35);
    color: #fbbf24;
    font-size: 13px;
  }

  .watch-player {
    position: relative;
    aspect-ratio: 16 / 9;
    border-radius: 8px;
    overflow: hidden;
    background: #000;
  }

  .watch-player-target {
    position: absolute;
    inset: 0;
  }

  .watch-player :global(iframe) {
    width: 100%;
    height: 100%;
    display: block;
  }

  .watch-shield {
    position: absolute;
    inset: 0;
    background: transparent;
    border: none;
    padding: 0;
    cursor: default;
  }

  .watch-controls {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-top: 12px;
  }

  .watch-play-btn {
    padding: 8px 16px;
    border-radius: 8px;
    border: 1px solid var(--border);
    background: var(--accent);
    color: var(--text);
    font-size: 13px;
    cursor: pointer;
    white-space: nowrap;
  }
  .watch-play-btn:hover {
    background: var(--accent-dim);
  }

  .watch-time {
    font-size: 12px;
    color: var(--muted);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }

  /* Match gain-row: kill global `input` chrome so ranges use brand colors, not OS blue. */
  .watch-scrubber,
  .watch-volume-slider {
    -webkit-appearance: none;
    appearance: none;
    accent-color: var(--accent-dim);
    padding: 0;
    height: 6px;
    border: none;
    border-radius: 999px;
    background: var(--border);
    cursor: pointer;
  }

  .watch-scrubber::-webkit-slider-runnable-track,
  .watch-volume-slider::-webkit-slider-runnable-track {
    height: 6px;
    border-radius: 999px;
    background: var(--border);
  }

  .watch-scrubber::-webkit-slider-thumb,
  .watch-volume-slider::-webkit-slider-thumb {
    -webkit-appearance: none;
    appearance: none;
    width: 16px;
    height: 16px;
    margin-top: -5px;
    border-radius: 50%;
    background: var(--accent-dim);
    border: 2px solid var(--text);
    box-shadow: 0 0 0 1px var(--accent);
  }

  .watch-scrubber::-moz-range-track,
  .watch-volume-slider::-moz-range-track {
    height: 6px;
    border-radius: 999px;
    background: var(--border);
  }

  .watch-scrubber::-moz-range-thumb,
  .watch-volume-slider::-moz-range-thumb {
    width: 16px;
    height: 16px;
    border: 2px solid var(--text);
    border-radius: 50%;
    background: var(--accent-dim);
  }

  .watch-scrubber {
    flex: 1;
  }

  .watch-volume-row {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-top: 10px;
    flex-wrap: wrap;
  }

  .watch-mute-btn {
    border: 1px solid var(--border);
    background: transparent;
    border-radius: 6px;
    padding: 4px 8px;
    cursor: pointer;
    font-size: 14px;
    line-height: 1;
  }

  .watch-volume-slider {
    width: 100px;
  }
</style>
