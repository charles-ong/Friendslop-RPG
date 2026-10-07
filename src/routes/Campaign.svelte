<script lang="ts">
  import { onMount } from 'svelte';
  import {
    loadCampaign,
    rollD20,
    takeTurn,
    updateMyCharacter,
    watchCampaign,
  } from '../lib/api';
  import { inviteLink } from '../lib/router.svelte';
  import SettingPicker from './SettingPicker.svelte';
  import type { Campaign, LogEntry, Player } from '../lib/types';

  let { id, userId }: { id: string; userId: string } = $props();

  let campaign = $state<Campaign | null>(null);
  let players = $state<Player[]>([]);
  let log = $state<LogEntry[]>([]);
  let loading = $state(true);
  let error = $state('');
  let copied = $state(false);

  let me = $derived(players.find((p) => p.user_id === userId));
  let isHost = $derived(campaign?.created_by === userId);
  let current = $derived(players.find((p) => p.id === campaign?.current_player_id));
  let host = $derived(players.find((p) => p.user_id === campaign?.created_by));

  let myTurn = $derived(campaign?.status === 'active' && !!me && me.id === campaign.current_player_id);
  let gmBusy = $derived(!!campaign?.gm_busy_since);

  let action = $state('');
  let rolled = $state<number | null>(null);
  let acting = $state(false);
  let turnError = $state('');

  let editName = $state('');
  let editCharacter = $state('');
  let saving = $state(false);

  onMount(() => {
    let stop = () => {};
    (async () => {
      try {
        const data = await loadCampaign(id);
        campaign = data.campaign;
        players = data.players;
        log = data.log;
        const mine = players.find((p) => p.user_id === userId);
        editName = mine?.name ?? '';
        editCharacter = mine?.character ?? '';
      } catch (e) {
        error = (e as Error).message;
      } finally {
        loading = false;
      }

      stop = watchCampaign(id, {
        onCampaign: (c) => (campaign = c),
        onPlayer: (p) => {
          const i = players.findIndex((x) => x.id === p.id);
          if (i === -1) players = [...players, p].sort((a, b) => a.seat - b.seat);
          else players[i] = p;
        },
        onLog: (e) => {
          if (!log.some((x) => x.id === e.id)) log = [...log, e];
        },
      });
    })();
    return () => stop();
  });

  async function copyInvite() {
    if (!campaign) return;
    const link = inviteLink(campaign.code);
    try {
      if (navigator.share) await navigator.share({ title: campaign.name, url: link });
      else await navigator.clipboard.writeText(link);
      copied = true;
      setTimeout(() => (copied = false), 2000);
    } catch {
      // Share sheet dismissed.
    }
  }

  async function saveCharacter(event: SubmitEvent) {
    event.preventDefault();
    saving = true;
    error = '';
    try {
      await updateMyCharacter(id, editName, editCharacter);
    } catch (e) {
      error = (e as Error).message;
    } finally {
      saving = false;
    }
  }

  async function act(event: SubmitEvent) {
    event.preventDefault();
    acting = true;
    turnError = '';
    const roll = rollD20();
    rolled = roll;
    try {
      await takeTurn(id, action.trim(), roll);
      action = '';
    } catch (e) {
      turnError = (e as Error).message;
    } finally {
      acting = false;
    }
  }

  function nameOf(playerId: string | null) {
    return players.find((p) => p.id === playerId)?.name ?? 'Someone';
  }
</script>

{#if loading}
  <p class="muted">Opening the tome…</p>
{:else if !campaign}
  <section class="card">
    <h2>Campaign not found</h2>
    <p class="muted">You may not be in this party yet. Ask a friend for the invite link.</p>
    <a href="#/">Back home</a>
  </section>
{:else}
  <section class="card">
    <h1>{campaign.name}</h1>
    <div class="row">
      <span class="pill">{campaign.status === 'lobby' ? 'Gathering the party' : `Turn ${campaign.turn_number}`}</span>
      <span class="muted">Code <span class="code">{campaign.code}</span></span>
    </div>
    {#if campaign.setting}<p class="setting">{campaign.setting}</p>{/if}
    <div class="row" style="margin-top: 12px">
      <button class="ghost" onclick={copyInvite}>{copied ? 'Link copied!' : 'Invite friends'}</button>
    </div>
    {#if error}<p class="error">{error}</p>{/if}
  </section>

  {#if campaign.status === 'lobby'}
    {#if isHost}
      <SettingPicker campaignId={id} />
    {:else}
      <p class="muted">Waiting for {host?.name ?? 'the host'} to choose a setting and begin…</p>
    {/if}
  {/if}

  {#if myTurn}
    <section class="card turn">
      <h2>Your turn!</h2>
      <form onsubmit={act}>
        <label for="action">What do you do?</label>
        <textarea
          id="action"
          bind:value={action}
          maxlength="500"
          rows="3"
          required
          disabled={acting}
          placeholder="I offer the grumpy toad a biscuit."
        ></textarea>
        <div class="row">
          <button disabled={acting || !action.trim()}>🎲 Roll & act</button>
          {#if rolled !== null}
            <span class="die" class:crit={rolled === 20} class:fumble={rolled === 1}>{rolled}</span>
          {/if}
          {#if acting}<span class="muted">The Gamemaster is narrating…</span>{/if}
        </div>
        {#if turnError}<p class="error">{turnError}</p>{/if}
      </form>
    </section>
  {/if}

  <section class="card">
    <h2>Party <span class="muted">({players.length}/10)</span></h2>
    <ul class="party">
      {#each players as p (p.id)}
        <li class:active={p.id === campaign.current_player_id}>
          <div class="avatar">{p.name.slice(0, 1).toUpperCase()}</div>
          <div class="who">
            <strong>{p.name}</strong>
            {#if p.user_id === userId}<span class="muted">(you)</span>{/if}
            {#if p.id === campaign.current_player_id}<span class="pill small">their turn</span>{/if}
            {#if p.character}<div class="muted small-text">{p.character}</div>{/if}
          </div>
          <div class="hp">❤️ {p.stats.hp}/{p.stats.max_hp}</div>
        </li>
      {/each}
    </ul>
  </section>

  {#if me}
    <section class="card">
      <h2>Your character</h2>
      <form onsubmit={saveCharacter}>
        <label for="ename">Name</label>
        <input id="ename" bind:value={editName} maxlength="24" required />
        <label for="echar">Who are they?</label>
        <textarea
          id="echar"
          bind:value={editCharacter}
          maxlength="280"
          rows="3"
          placeholder="A nervous bard who collects spoons."
        ></textarea>
        <button disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
      </form>
    </section>
  {/if}

  <section class="card">
    <h2>Adventure log</h2>
    {#if gmBusy && !acting}
      <p class="muted">The Gamemaster is narrating…</p>
    {:else if current && campaign.status === 'active' && !myTurn}
      <p class="muted">Waiting on {current.name}…</p>
    {/if}
    <ol class="log">
      {#each log as e (e.id)}
        <li class={e.kind}>
          {#if e.kind === 'action'}<strong>{nameOf(e.player_id)}:</strong>{/if}
          {e.content}
          {#if e.roll}<span class="pill small">🎲 d{e.roll.die} → {e.roll.result}</span>{/if}
        </li>
      {/each}
    </ol>
  </section>
{/if}

<style>
  .pill {
    display: inline-block;
    background: var(--mint);
    border-radius: 999px;
    padding: 2px 10px;
    font-size: 0.85rem;
    font-weight: 700;
  }
  .setting {
    margin: 8px 0 0;
    font-size: 0.95rem;
  }
  .pill.small {
    font-size: 0.75rem;
    padding: 0 8px;
    margin-left: 4px;
  }
  .party {
    list-style: none;
    padding: 0;
    margin: 0;
  }
  .party li {
    display: flex;
    gap: 12px;
    align-items: center;
    padding: 8px;
    border-radius: 14px;
  }
  .party li.active {
    background: var(--soft);
  }
  .avatar {
    flex: none;
    width: 36px;
    height: 36px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    background: var(--accent);
    color: var(--accent-ink);
    font-weight: 800;
  }
  .who {
    flex: 1;
    min-width: 0;
  }
  .small-text {
    font-size: 0.85rem;
  }
  .hp {
    flex: none;
    font-size: 0.9rem;
  }
  .log {
    list-style: none;
    padding: 0;
    margin: 0;
  }
  .log li {
    padding: 8px 0;
    border-bottom: 1px dashed var(--line);
  }
  .log li:last-child {
    border-bottom: none;
  }
  .log li.narration {
    white-space: pre-wrap;
  }
  .turn {
    border-color: var(--accent);
  }
  .die {
    display: inline-grid;
    place-items: center;
    width: 40px;
    height: 40px;
    border-radius: 12px;
    background: var(--soft);
    font-weight: 800;
    font-size: 1.1rem;
    animation: tumble 0.4s ease-out;
  }
  .die.crit {
    background: var(--mint);
  }
  .die.fumble {
    color: var(--danger);
  }
  @keyframes tumble {
    from {
      transform: rotate(-200deg) scale(0.6);
    }
  }
  .log li.system {
    color: var(--muted);
    font-style: italic;
    font-size: 0.9rem;
  }
</style>
