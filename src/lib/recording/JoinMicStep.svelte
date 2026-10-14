<script>
  import { Mic } from '$lib/icons'
  import MicPanel from '$lib/recording/MicPanel.svelte'

  let {
    devices = [],
    selectedDeviceId = $bindable(''),
    micPermission = 'prompt',
    audioInitError = '',
    micFallback = false,
    micFallbackName = '',
    gainValue = $bindable(1.0),
    gainDb = 0,
    onChangeMic = () => {},
    onGainInput = () => {},
    onContinue = () => {}
  } = $props()
</script>

<main class="gate-wrap">
  <div class="card gate-card">
    <div class="gate-icon"><Mic size={36} /></div>
    <h2>Microphone</h2>
    <p class="sub">Choose the mic this device will record with. You can change it later in the room.</p>
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
    <button type="button" class="btn-primary btn-block" onclick={onContinue}>
      Continue to room
    </button>
  </div>
</main>

<style>
  .gate-wrap {
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 20px;
  }

  .gate-card {
    max-width: 440px;
    width: 100%;
    text-align: center;
    position: relative;
  }

  .gate-icon {
    display: flex;
    justify-content: center;
    margin-bottom: 12px;
    color: var(--text);
  }

  h2 {
    font-size: 20px;
    font-weight: 600;
    margin-bottom: 4px;
  }

  .sub {
    color: var(--muted);
    font-size: 13px;
    margin-bottom: 20px;
    line-height: 1.5;
  }

  .btn-block {
    margin-top: 16px;
  }
</style>
