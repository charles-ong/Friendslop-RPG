<script lang="ts">
  import { onMount } from 'svelte';
  import { createCampaign, myCampaigns } from '../lib/api';
  import { go } from '../lib/router.svelte';
  import { saveName, savedName } from '../lib/prefs';
  import type { Campaign } from '../lib/types';

  let { userId }: { userId: string } = $props();

  let playerName = $state(savedName());
  let campaignName = $state('');
  let joinCode = $state('');
  let busy = $state(false);
  let error = $state('');
  let campaigns = $state<Campaign[]>([]);

  onMount(async () => {
    try {
      campaigns = await myCampaigns(userId);
    } catch {
      // The list is a convenience; the page works without it.
    }
  });

  async function create(event: SubmitEvent) {
    event.preventDefault();
    busy = true;
    error = '';
    try {
      saveName(playerName.trim());
      const c = await createCampaign(campaignName, playerName);
      go(`/c/${c.id}`);
    } catch (e) {
      error = (e as Error).message;
    } finally {
      busy = false;
    }
  }

  function join(event: SubmitEvent) {
    event.preventDefault();
    go(`/join/${joinCode.trim().toUpperCase()}`);
  }
</script>

{#if campaigns.length}
  <section class="card">
    <h2>Your campaigns</h2>
    <ul class="list">
      {#each campaigns as c (c.id)}
        <li>
          <a href={`#/c/${c.id}`}>{c.name}</a>
          <span class="muted">· {c.status}</span>
        </li>
      {/each}
    </ul>
  </section>
{/if}

<section class="card">
  <h2>Start a campaign</h2>
  <form onsubmit={create}>
    <label for="pname">Your name</label>
    <input id="pname" bind:value={playerName} maxlength="24" required placeholder="Pip" />
    <label for="cname">Campaign name</label>
    <input
      id="cname"
      bind:value={campaignName}
      maxlength="60"
      required
      placeholder="The Lost Teacup"
    />
    <button disabled={busy}>Create</button>
    {#if error}<p class="error">{error}</p>{/if}
  </form>
</section>

<section class="card">
  <h2>Join with a code</h2>
  <form onsubmit={join} class="row">
    <input
      bind:value={joinCode}
      class="code"
      maxlength="6"
      required
      placeholder="ABC234"
      aria-label="Join code"
      style="flex: 1; margin: 0; min-width: 0"
    />
    <button class="ghost">Join</button>
  </form>
</section>

<style>
  .list {
    list-style: none;
    padding: 0;
    margin: 0;
  }
  .list li {
    padding: 6px 0;
  }
  .list a {
    color: inherit;
    font-weight: 700;
  }
</style>
