<script lang="ts">
  import { onMount, tick } from 'svelte';
  import {
    loadCampaign,
    markSeen,
    removePlayer,
    rollD20,
    skipTurn,
    takeTurn,
    updateMyCharacter,
    watchCampaign,
  } from '../lib/api';
  import { inviteLink } from '../lib/router.svelte';
  import SettingPicker from './SettingPicker.svelte';
  import TurnStatus from './TurnStatus.svelte';
  import { alertsEnabled, alertsSupported, enableAlerts, notify, subscribeToPush } from '../lib/alerts';
  import Notifications from './Notifications.svelte';
  import { ago } from '../lib/time';
  import type { Campaign, LogEntry, Nudge, Player } from '../lib/types';

  let { id, userId }: { id: string; userId: string } = $props();

  let campaign = $state<Campaign | null>(null);
  let players = $state<Player[]>([]);
  let log = $state<LogEntry[]>([]);
  let nudges = $state<Nudge[]>([]);
  let presence = $state<Set<string>>(new Set());
  let now = $state(Date.now());
  let alertsOn = $state(alertsEnabled());
  let toast = $state('');
  let loading = $state(true);
  let error = $state('');
  let copied = $state(false);
  let removed = $state(false);
  // Long logs show the latest entries first; "Show earlier" reveals more.
  const LOG_PAGE = 40;
  let logShown = $state(LOG_PAGE);
  let visibleLog = $derived(log.slice(Math.max(0, log.length - logShown)));
  // Where the story meets the turn box. "Jump to latest" scrolls here.
  let latest = $state<HTMLElement | null>(null);
  let latestInView = $state(true);
  // Names of players who left, so their old actions keep a name.
  const formerNames = new Map<string, string>();

  let me = $derived(players.find((p) => p.user_id === userId));
  // You're always online to yourself, even before presence syncs.
  let online = $derived(me ? new Set([...presence, me.id]) : presence);
  let isHost = $derived(campaign?.created_by === userId);
  let current = $derived(players.find((p) => p.id === campaign?.current_player_id));
  let host = $derived(players.find((p) => p.user_id === campaign?.created_by));

  let myTurn = $derived(campaign?.status === 'active' && !!me && me.id === campaign.current_player_id);
  let gmBusy = $derived(!!campaign?.gm_busy_since);
  let turnNudges = $derived(
    nudges.filter((n) => n.turn_number === campaign?.turn_number && n.to_player === campaign?.current_player_id),
  );

  // Flag the tab when it's your turn, so it stands out among open tabs.
  $effect(() => {
    const base = campaign ? `${campaign.name} · Friendslop RPG` : 'Friendslop RPG';
    document.title = myTurn ? `(Your turn!) ${base}` : base;
  });

  let lastTurnAlerted = -1;
  $effect(() => {
    if (myTurn && campaign && campaign.turn_number !== lastTurnAlerted) {
      lastTurnAlerted = campaign.turn_number;
      notify("It's your turn!", `${campaign.name}: the party is waiting for you.`, `turn-${campaign.id}`);
    }
  });

  let action = $state('');
  let rolled = $state<number | null>(null);
  let acting = $state(false);
  let turnError = $state('');

  let editName = $state('');
  let editCharacter = $state('');
  let saving = $state(false);

  onMount(() => {
    let stop = () => {};
    let alive = true;

    const seen = () => {
      if (document.visibilityState === 'visible') markSeen(id).catch(() => {});
    };
    const timer = setInterval(() => {
      now = Date.now();
      seen();
    }, 60_000);
    document.addEventListener('visibilitychange', seen);

    (async () => {
      let mine: Player | undefined;
      try {
        const data = await loadCampaign(id);
        campaign = data.campaign;
        players = data.players;
        log = data.log;
        nudges = data.nudges;
        mine = players.find((p) => p.user_id === userId);
        editName = mine?.name ?? '';
        editCharacter = mine?.character ?? '';
      } catch (e) {
        error = (e as Error).message;
      } finally {
        loading = false;
      }
      if (!alive) return;
      seen();
      await tick();
      if (log.length > 3) latest?.scrollIntoView({ block: 'end' });
      // Keeps this browser's push subscription tied to this player.
      if (mine && alertsOn) subscribeToPush();

      stop = watchCampaign(id, mine?.id, {
        onCampaign: (c) => (campaign = c),
        onPlayer: (p) => {
          const i = players.findIndex((x) => x.id === p.id);
          if (i === -1) players = [...players, p].sort((a, b) => a.seat - b.seat);
          else players[i] = p;
        },
        onPlayerGone: (playerId) => {
          const gone = players.find((p) => p.id === playerId);
          if (!gone) return;
          formerNames.set(gone.id, gone.name);
          players = players.filter((p) => p.id !== playerId);
          if (gone.user_id === userId) removed = true;
        },
        onLog: (e) => {
          if (log.some((x) => x.id === e.id)) return;
          const follow = latestInView;
          log = [...log, e];
          logShown += 1;
          // Keep up with the story if you were already reading the end of it.
          if (follow) tick().then(() => latest?.scrollIntoView({ block: 'end', behavior: 'smooth' }));
        },
        onNudge: (n) => {
          if (nudges.some((x) => x.id === n.id)) return;
          nudges = [...nudges, n];
          if (n.to_player === me?.id) {
            const from = nameOf(n.from_player);
            showToast(`👉 ${from} nudged you. It's your turn!`);
            notify(`${from} nudged you 👉`, "It's your turn. The party is waiting!", `turn-${id}`);
          }
        },
        onOnline: (ids) => (presence = ids),
      });
    })();

    return () => {
      alive = false;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', seen);
      stop();
    };
  });

  $effect(() => {
    if (!latest) return;
    const observer = new IntersectionObserver(([entry]) => (latestInView = entry.isIntersecting), {
      rootMargin: '0px 0px 80px 0px',
    });
    observer.observe(latest);
    return () => observer.disconnect();
  });

  function jumpToLatest() {
    latest?.scrollIntoView({ block: 'end', behavior: 'smooth' });
  }

  let controlError = $state('');
  async function passTurn() {
    if (!current || !confirm(myTurn ? 'Pass your turn to the next player?' : `Skip ${current.name}'s turn?`)) return;
    controlError = '';
    try {
      await skipTurn(id);
    } catch (e) {
      controlError = (e as Error).message;
    }
  }

  async function kick(p: Player) {
    if (!confirm(`Remove ${p.name} from the party? They can rejoin with the invite link.`)) return;
    controlError = '';
    try {
      await removePlayer(id, p.id);
    } catch (e) {
      controlError = (e as Error).message;
    }
  }

  function showToast(text: string) {
    toast = text;
    setTimeout(() => (toast = ''), 5000);
  }

  async function turnOnAlerts() {
    alertsOn = await enableAlerts();
  }

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
    return players.find((p) => p.id === playerId)?.name ?? (playerId && formerNames.get(playerId)) ?? 'Someone';
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

  {#if campaign.status !== 'lobby' || log.length > 1}
    <section class="card">
      <h2>Adventure log</h2>
      {#if log.length > visibleLog.length}
        <button class="ghost small-btn" onclick={() => (logShown += LOG_PAGE)}>
          Show earlier ({log.length - visibleLog.length} more)
        </button>
      {/if}
      <ol class="log">
        {#each visibleLog as e, i (e.id)}
          {#if e.turn_number > 0 && (i === 0 || visibleLog[i - 1].turn_number !== e.turn_number)}
            <li class="turn-break" aria-hidden="true"><span>Turn {e.turn_number}</span></li>
          {/if}
          <li class={e.kind}>
            {#if e.kind === 'narration'}<span class="story">{e.content}</span>{:else}
              {#if e.kind === 'action'}<strong>{nameOf(e.player_id)}:</strong>{/if}
              {e.content}
              {#if e.roll}<span class="pill small">🎲 d{e.roll.die} → {e.roll.result}</span>{/if}
            {/if}
          </li>
        {/each}
      </ol>
    </section>
  {/if}

  {#if removed}
    <section class="card">
      <h2>You've left this party</h2>
      <p class="muted">The host removed you. You can rejoin with the invite link if they share it again.</p>
      <a href="#/">Back home</a>
    </section>
  {/if}

  {#if myTurn}
    <section class="card turn">
      <h2>Your turn!</h2>
      {#if turnNudges.length}
        <p class="muted">
          👉 {[...new Set(turnNudges.map((n) => nameOf(n.from_player)))].join(', ')}
          {turnNudges.length === 1 ? 'nudged you' : `nudged you ${turnNudges.length} times`}
        </p>
      {/if}
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
      <button class="link pass" onclick={passTurn} disabled={acting}>Pass my turn</button>
      {#if controlError}<p class="error">{controlError}</p>{/if}
    </section>
  {/if}

  {#if campaign.status === 'active' && current && !myTurn}
    <TurnStatus
      campaignId={id}
      {current}
      online={online.has(current.id)}
      {gmBusy}
      nudges={turnNudges}
      {now}
      canSkip={isHost}
      onSkip={passTurn}
    />
    {#if controlError}<p class="error">{controlError}</p>{/if}
  {/if}

  <div bind:this={latest} class="latest-anchor"></div>

  {#if me && alertsSupported() && !alertsOn && campaign.status !== 'ended'}
    <p class="alerts muted">
      <button class="link" onclick={turnOnAlerts}>Turn on notifications</button> to hear when it's your turn,
      even with this page closed, or add your email under Notifications.
    </p>
  {/if}

  <section class="card">
    <h2>Party <span class="muted">({players.length}/10)</span></h2>
    <ul class="party">
      {#each players as p (p.id)}
        <li class:active={p.id === campaign.current_player_id}>
          <div class="avatar">
            {p.name.slice(0, 1).toUpperCase()}
            <span
              class="dot"
              class:on={online.has(p.id)}
              title={online.has(p.id) ? 'Online' : `Last seen ${ago(p.last_seen_at, now)}`}
            ></span>
          </div>
          <div class="who">
            <strong>{p.name}</strong>
            {#if p.user_id === userId}<span class="muted">(you)</span>{/if}
            {#if p.id === campaign.current_player_id}<span class="pill small">{p.user_id === userId ? 'your turn' : 'their turn'}</span>{/if}
            {#if p.character}<div class="muted small-text">{p.character}</div>{/if}
            {#if !online.has(p.id) && p.user_id !== userId}
              <div class="muted small-text">Away · seen {ago(p.last_seen_at, now)}</div>
            {/if}
          </div>
          <div class="hp">❤️ {p.stats.hp}/{p.stats.max_hp}</div>
          {#if isHost && p.user_id !== userId}
            <button class="remove" onclick={() => kick(p)} aria-label={`Remove ${p.name}`} title="Remove from party">✕</button>
          {/if}
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

    {#if campaign.status !== 'ended'}
      <Notifications campaignId={id} bind:alertsOn />
    {/if}
  {/if}

{/if}

{#if campaign && !latestInView && log.length > 3}
  <button class="jump" onclick={jumpToLatest}>⬇ Latest</button>
{/if}

{#if toast}<div class="toast" role="status">{toast}</div>{/if}

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
    position: relative;
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
  .dot {
    position: absolute;
    right: -2px;
    bottom: -2px;
    width: 12px;
    height: 12px;
    border-radius: 50%;
    border: 2px solid var(--card);
    background: var(--line);
  }
  .dot.on {
    background: #3ccf8e;
  }
  .alerts {
    margin: -4px 4px 16px;
    font-size: 0.9rem;
  }
  button.link {
    background: none;
    color: var(--accent);
    padding: 0;
    border-radius: 0;
    min-height: 0;
    text-decoration: underline;
  }
  .toast {
    position: fixed;
    left: 50%;
    bottom: calc(16px + env(safe-area-inset-bottom));
    transform: translateX(-50%);
    max-width: calc(100% - 32px);
    background: var(--ink);
    color: var(--bg);
    padding: 10px 16px;
    border-radius: 999px;
    font-weight: 700;
    box-shadow: 0 4px 16px rgb(0 0 0 / 0.2);
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
  .log li.narration .story {
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
  .log li.turn-break {
    border-bottom: none;
    padding: 12px 0 0;
    text-align: center;
    font-size: 0.75rem;
    font-weight: 800;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--muted);
  }
  .log li.turn-break span {
    background: var(--card);
    padding: 0 8px;
  }
  .log li.turn-break::before {
    content: '';
    display: block;
    border-top: 2px solid var(--line);
    margin-bottom: -0.75em;
  }
  .log li:has(+ .turn-break) {
    border-bottom: none;
  }
  .log li.action {
    background: var(--soft);
    border-radius: 12px;
    padding: 8px 12px;
    margin: 6px 0;
    border-bottom: none;
  }
  .small-btn {
    min-height: 36px;
    padding: 6px 14px;
    font-size: 0.85rem;
    margin-bottom: 8px;
  }
  .latest-anchor {
    scroll-margin-bottom: 16px;
  }
  .pass {
    margin-top: 12px;
    font-size: 0.9rem;
  }
  .remove {
    flex: none;
    width: 44px;
    height: 44px;
    padding: 0;
    background: none;
    color: var(--muted);
    font-size: 1rem;
  }
  .remove:hover {
    color: var(--danger);
  }
  .jump {
    position: fixed;
    right: 16px;
    bottom: calc(16px + env(safe-area-inset-bottom));
    box-shadow: 0 4px 16px rgb(0 0 0 / 0.2);
  }
  .log li.system {
    color: var(--muted);
    font-style: italic;
    font-size: 0.9rem;
  }
</style>
