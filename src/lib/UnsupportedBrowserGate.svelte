<script>
  import { Ban, Check, X } from '$lib/icons'

  export let slug = ''
</script>

<main class="gate-wrap">
  <div class="card gate-card browser-card">
    <div class="gate-icon"><Ban size={36} /></div>
    <h2>Browser not supported</h2>
    <p class="sub">
      Recording requires the <strong>File System Access API</strong> to stream
      audio directly to your disk. Your current browser doesn't support it.
    </p>
    <div class="browser-list">
      <div class="browser-item ok"><Check /> Chrome</div>
      <div class="browser-item ok"><Check /> Edge</div>
      <div class="browser-item ok"><Check /> Brave</div>
      <div class="browser-item ok"><Check /> Opera</div>
      <div class="browser-item bad"><X /> Safari</div>
      <div class="browser-item bad"><X /> Firefox</div>
      <div class="browser-item bad"><X /> DuckDuckGo</div>
    </div>
    <p class="browser-note">
      Open this link in Chrome or Edge and you're good to go.<br />
      The room URL is: <code>{slug}</code>
    </p>
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
    max-width: 380px;
    width: 100%;
    text-align: center;
    position: relative;
  }

  .browser-card {
    max-width: 440px;
  }

  .gate-icon {
    display: flex;
    justify-content: center;
    margin-bottom: 12px;
    color: var(--text);
  }

  .browser-list {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 6px;
    margin: 16px 0;
    text-align: left;
  }

  .browser-item {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 7px 12px;
    border-radius: var(--radius);
    font-size: 13px;
    font-weight: 500;
  }

  .browser-item.ok {
    background: rgba(34, 197, 94, .1);
    color: var(--success-text);
  }

  .browser-item.bad {
    background: rgba(239, 68, 68, .08);
    color: var(--danger-text);
  }

  .browser-note {
    font-size: 12px;
    color: var(--muted);
    line-height: 1.7;
    margin-top: 4px;
  }

  .browser-note code {
    background: var(--border);
    padding: 1px 6px;
    border-radius: 4px;
    font-family: monospace;
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
  }
</style>
