<script lang="ts">
  import { onMount } from 'svelte';
  import { createCampaign, myCampaigns, type CampaignSummary } from '../lib/api';
  import { go } from '../lib/router.svelte';
  import { saveName, savedName } from '../lib/prefs';

  let { userId }: { userId: string } = $props();

  let playerName = $state(savedName());
  let campaignName = $state('');
  let joinCode = $state('');
  let busy = $state(false);
  let error = $state('');
  let campaigns = $state<CampaignSummary[]>([]);

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
          <a href={`#/c/${c.id}`} class:mine={c.myTurn}>
            <span class="name">{c.name}</span>
            <span class="state">
              {#if c.myTurn}
                <span class="pill">🎲 Your turn!</span>
              {:else if c.status === 'active'}
                <span class="muted">Waiting on {c.currentName ?? 'someone'}</span>
              {:else if c.status === 'lobby'}
                <span class="muted">Gathering the party · {c.partySize} joined</span>
              {:else}
                <span class="muted">Ended</span>
              {/if}
            </span>
          </a>
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
  .list li + li {
    margin-top: 8px;
  }
  .list a {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 10px 14px;
    border-radius: 14px;
    background: var(--bg);
    color: inherit;
    text-decoration: none;
  }
  .list a.mine {
    background: var(--soft);
  }
  .name {
    font-weight: 700;
  }
  .state {
    font-size: 0.9rem;
  }
  .pill {
    display: inline-block;
    background: var(--accent);
    color: var(--accent-ink);
    border-radius: 999px;
    padding: 0 10px;
    font-weight: 700;
    font-size: 0.85rem;
  }
</style>
