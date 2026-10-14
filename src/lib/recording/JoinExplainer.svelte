<script>
  import { Download02 } from '$lib/icons'
  import {
    LOCAL_COPY_FOLDER,
    LOCAL_COPY_HEADING,
    LOCAL_COPY_INSURANCE,
    LOCAL_COPY_SERVER_COPY
  } from '$lib/recording/join-step.js'

  let { choosing = false, onChooseSaveLocation = () => {} } = $props()
</script>

<main class="gate-wrap">
  <div class="card gate-card">
    <div class="gate-icon"><Download02 size={36} /></div>
    <h2>{LOCAL_COPY_HEADING}</h2>
    <p class="sub">{LOCAL_COPY_INSURANCE}</p>
    <p class="sub">{LOCAL_COPY_SERVER_COPY}</p>
    <p class="sub">{LOCAL_COPY_FOLDER}</p>
    <button
      type="button"
      class="btn-primary btn-block"
      disabled={choosing}
      onclick={onChooseSaveLocation}
    >
      Choose save location
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
    max-width: 420px;
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
    margin-bottom: 16px;
    line-height: 1.5;
    text-align: left;
  }
</style>
