<script lang="ts">
  import { joinCampaign } from '../lib/api';
  import { go } from '../lib/router.svelte';
  import { saveName, savedName } from '../lib/prefs';

  let { code }: { code: string } = $props();

  let playerName = $state(savedName());
  let busy = $state(false);
  let error = $state('');

  async function join(event: SubmitEvent) {
    event.preventDefault();
    busy = true;
    error = '';
    try {
      saveName(playerName.trim());
      const c = await joinCampaign(code, playerName);
      go(`/c/${c.id}`);
    } catch (e) {
      error = (e as Error).message;
    } finally {
      busy = false;
    }
  }
</script>

<section class="card">
  <h2>You're invited!</h2>
  <p class="muted">Joining party <span class="code">{code}</span></p>
  <form onsubmit={join}>
    <label for="pname">Your name</label>
    <input id="pname" bind:value={playerName} maxlength="24" required placeholder="Pip" />
    <button disabled={busy}>Join the party</button>
    {#if error}<p class="error">{error}</p>{/if}
  </form>
</section>
