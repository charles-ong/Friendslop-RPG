<script lang="ts">
  import { nudge } from '../lib/api';
  import { ago } from '../lib/time';
  import type { Nudge, Player } from '../lib/types';

  let {
    campaignId,
    current,
    online,
    gmBusy,
    nudges,
    now,
  }: {
    campaignId: string;
    current: Player;
    online: boolean;
    gmBusy: boolean;
    nudges: Nudge[];
    now: number;
  } = $props();

  let sending = $state(false);
  let sent = $state(false);
  let error = $state('');

  async function poke() {
    sending = true;
    error = '';
    try {
      await nudge(campaignId);
      sent = true;
      setTimeout(() => (sent = false), 3000);
    } catch (e) {
      error = (e as Error).message;
    } finally {
      sending = false;
    }
  }
</script>

<section class="card status" class:paused={!online && !gmBusy}>
  {#if gmBusy}
    <p><strong>The Gamemaster is narrating…</strong></p>
  {:else if online}
    <p><strong>{current.name}</strong> is taking their turn…</p>
  {:else}
    <p class="title">💤 The world is paused</p>
    <p class="muted">
      It's {current.name}'s turn, but they're away (last seen {ago(current.last_seen_at, now)}).
      Everyone is safe until they're back.
    </p>
  {/if}

  {#if !gmBusy}
    <div class="row">
      <button class="ghost" onclick={poke} disabled={sending || sent}>
        {sent ? 'Nudged! 👉' : `👉 Nudge ${current.name}`}
      </button>
      {#if nudges.length}
        <span class="muted small">Nudged {nudges.length} {nudges.length === 1 ? 'time' : 'times'} this turn</span>
      {/if}
    </div>
    {#if error}<p class="error">{error}</p>{/if}
  {/if}
</section>

<style>
  .status p {
    margin: 0 0 10px;
  }
  .status.paused {
    background: var(--soft);
  }
  .title {
    font-weight: 800;
    font-size: 1.1rem;
  }
  .small {
    font-size: 0.85rem;
  }
</style>
