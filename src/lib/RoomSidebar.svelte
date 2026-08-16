<script>
  import RoomDetailsPanel from "./RoomDetailsPanel.svelte";
  import MicPanel from "./MicPanel.svelte";
  import WaveformPanel from "./WaveformPanel.svelte";
  import RecordControls from "./RecordControls.svelte";

  // Composes the four sidebar panels in the sketch's order: room details,
  // mic selection, waveform, then record/clap. Purely a forwarding wrapper —
  // no state of its own — so the room page has one component to wire up
  // instead of four.

  // Room details
  export let roomName;
  export let slug;
  export let isHostClaim = false;
  export let roomPassword = null;
  export let myRole = null;
  export let wsStatus = "disconnected";
  export let peers = [];
  export let clientId = null;
  export let copyLinkDone = false;
  export let onCopyLink = () => {};

  // Mic
  export let devices = [];
  export let selectedDeviceId = "";
  export let micPermission = "prompt";
  export let audioInitError = "";
  export let micFallback = false;
  export let micFallbackName = "";
  export let gainValue = 1.0;
  export let gainDb = 0;
  export let onChangeMic = () => {};
  export let onGainInput = () => {};

  // Waveform
  export let canvasEl = null;
  export let meterPct = 0;
  export let peakPct = 0;
  export let dbLevel;
  export let peakHoldDb;
  export let isClipping = false;
  export let lastClapFrom = null;

  // Record / clap
  export let recordingState = "idle";
  export let canRecord = false;
  export let myPeerIsRecording = false;
  export let recordingSeconds = 0;
  export let bytesWritten = 0;
  export let onToggleRecording = () => {};
  export let onClap = () => {};
  export let formatTime = (s) => String(s);
  export let formatBytes = (b) => String(b);
</script>

<aside class="room-sidebar">
  <section class="sidebar-section">
    <RoomDetailsPanel {roomName} {slug} {isHostClaim} {roomPassword} {myRole} {wsStatus} {peers} {clientId} {copyLinkDone} {onCopyLink} />
  </section>

  <section class="sidebar-section">
    <MicPanel
      {devices}
      bind:selectedDeviceId
      {micPermission}
      {audioInitError}
      {micFallback}
      {micFallbackName}
      bind:gainValue
      {gainDb}
      {onChangeMic}
      {onGainInput}
    />
  </section>

  <section class="sidebar-section">
    <WaveformPanel bind:canvasEl {meterPct} {peakPct} {dbLevel} {peakHoldDb} {isClipping} {lastClapFrom} />
  </section>

  <section class="sidebar-section">
    <RecordControls
      {recordingState}
      {canRecord}
      {micPermission}
      {wsStatus}
      {myPeerIsRecording}
      {recordingSeconds}
      {bytesWritten}
      {onToggleRecording}
      {onClap}
      {formatTime}
      {formatBytes}
    />
  </section>
</aside>

<style>
  .room-sidebar {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }

  .sidebar-section {
    padding: 14px;
    border-radius: 10px;
    border: 1px solid var(--border);
    background: var(--bg-elevated);
  }
</style>
