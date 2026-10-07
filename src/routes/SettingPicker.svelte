<script lang="ts">
  import { beginCampaign, suggestSettings } from '../lib/api';
  import type { SettingIdea } from '../lib/types';

  let { campaignId }: { campaignId: string } = $props();

  let ideas = $state<SettingIdea[]>([]);
  let picked = $state<number | 'custom' | null>(null);
  let custom = $state('');
  let loadingIdeas = $state(false);
  let starting = $state(false);
  let error = $state('');

  let chosen = $derived(
    picked === 'custom'
      ? custom.trim()
      : picked !== null && ideas[picked]
        ? `${ideas[picked].title}: ${ideas[picked].pitch}`
        : '',
  );

  async function roll() {
    loadingIdeas = true;
    error = '';
    try {
      ideas = await suggestSettings(campaignId);
      if (picked !== 'custom') picked = null;
    } catch (e) {
      error = (e as Error).message;
    } finally {
      loadingIdeas = false;
    }
  }

  async function begin() {
    starting = true;
    error = '';
    try {
      await beginCampaign(campaignId, chosen);
    } catch (e) {
      error = (e as Error).message;
      starting = false;
    }
  }
</script>

<section class="card">
  <h2>Choose a setting</h2>
  <p class="muted">Pick where the story starts. The Gamemaster will write the opening scene.</p>

  {#if ideas.length}
    <div class="ideas">
      {#each ideas as idea, i (i)}
        <button
          type="button"
          class="idea"
          class:selected={picked === i}
          aria-pressed={picked === i}
          onclick={() => (picked = i)}
          disabled={starting}
        >
          <strong>{idea.title}</strong>
          <span>{idea.pitch}</span>
        </button>
      {/each}
    </div>
  {/if}

  <button type="button" class="ghost" onclick={roll} disabled={loadingIdeas || starting}>
    {loadingIdeas ? 'Dreaming up ideas…' : ideas.length ? '🎲 Reroll ideas' : '🎲 Suggest 3 settings'}
  </button>

  <label for="custom" class="custom-label">Or write your own</label>
  <textarea
    id="custom"
    rows="2"
    maxlength="600"
    bind:value={custom}
    onfocus={() => (picked = 'custom')}
    disabled={starting}
    placeholder="A floating tea-house drifting between storm clouds, where the kettle has gone missing."
  ></textarea>

  <button type="button" onclick={begin} disabled={!chosen || starting}>
    {starting ? 'Writing the opening…' : 'Begin adventure'}
  </button>
  {#if error}<p class="error">{error}</p>{/if}
</section>

<style>
  .ideas {
    display: grid;
    gap: 8px;
    margin-bottom: 12px;
  }
  .idea {
    display: grid;
    gap: 2px;
    text-align: left;
    font-weight: 400;
    background: var(--bg);
    color: var(--ink);
    border: 2px solid var(--line);
    border-radius: 14px;
    padding: 10px 12px;
  }
  .idea.selected {
    border-color: var(--accent);
    background: var(--soft);
  }
  .idea span {
    font-size: 0.9rem;
    color: var(--muted);
  }
  .custom-label {
    margin-top: 16px;
  }
</style>
