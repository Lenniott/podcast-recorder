<script>
  import RoomSidebar from '$lib/RoomSidebar.svelte'
  import RoomTabs from '$lib/RoomTabs.svelte'

  export let sidebarCollapsed = false
  export let roomTabs = null
  export let canvasEl

  export let roomName = ''
  export let slug = ''
  export let isHostClaim = false
  export let roomPassword = ''
  export let wsStatus = 'disconnected'
  export let peers = []
  export let clientId = null
  export let copyLinkDone = false
  export let onCopyLink = () => {}
  export let devices = []
  export let selectedDeviceId = ''
  export let micPermission = 'prompt'
  export let audioInitError = ''
  export let micFallback = false
  export let micFallbackName = ''
  export let gainValue = 1
  export let gainDb = 0
  export let onChangeMic = () => {}
  export let onGainInput = () => {}
  export let meterPct = 0
  export let peakPct = 0
  export let dbLevel = -60
  export let peakHoldDb = -60
  export let isClipping = false
  export let lastClapFrom = null
  export let recordingState = 'idle'
  export let canRecord = false
  export let myPeerIsRecording = false
  export let recordingSeconds = 0
  export let bytesWritten = 0
  export let onToggleRecording = () => {}
  export let onClap = () => {}
  export let formatTime = (s) => String(s)
  export let formatBytes = (b) => String(b)
  export let send = () => {}
  export let clockOffset = 0
</script>

<div class="room" class:sidebar-collapsed={sidebarCollapsed}>
  <RoomSidebar
    bind:collapsed={sidebarCollapsed}
    {roomName}
    {slug}
    {isHostClaim}
    {roomPassword}
    {wsStatus}
    {peers}
    {clientId}
    {copyLinkDone}
    {onCopyLink}
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
    bind:canvasEl
    {meterPct}
    {peakPct}
    {dbLevel}
    {peakHoldDb}
    {isClipping}
    {lastClapFrom}
    {recordingState}
    {canRecord}
    {myPeerIsRecording}
    {recordingSeconds}
    {bytesWritten}
    {onToggleRecording}
    {onClap}
    {formatTime}
    {formatBytes}
  />

  <main class="room-main">
    <RoomTabs {send} {clockOffset} bind:this={roomTabs} />
  </main>
</div>

<style>
  .room {
    height: 100vh;
    display: grid;
    grid-template-columns: 240px 1fr;
    gap: 20px;
    max-width: 1400px;
    margin: 0 auto;
    overflow: hidden;
  }

  .room.sidebar-collapsed {
    grid-template-columns: 72px 1fr;
  }

  .room-main {
    min-width: 0;
    min-height: 0;
    padding: 20px 0;
    overflow-y: auto;
    overscroll-behavior: contain;
  }

  @media (max-width: 720px) {
    .room,
    .room.sidebar-collapsed {
      grid-template-columns: 1fr;
      grid-template-rows: auto 1fr;
    }
  }
</style>
