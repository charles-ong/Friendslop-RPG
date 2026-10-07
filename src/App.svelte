<script lang="ts">
  import { onMount } from 'svelte';
  import { ensureSession } from './lib/supabase';
  import { router } from './lib/router.svelte';
  import Home from './routes/Home.svelte';
  import Join from './routes/Join.svelte';
  import Campaign from './routes/Campaign.svelte';

  let userId = $state<string | null>(null);
  let error = $state('');

  onMount(async () => {
    try {
      userId = await ensureSession();
    } catch (e) {
      error = (e as Error).message;
    }
  });
</script>

<main>
  <header>
    <a href="#/" class="brand">🎲 Friendslop RPG</a>
  </header>

  {#if error}
    <div class="card">
      <h2>Couldn't connect</h2>
      <p class="error">{error}</p>
    </div>
  {:else if !userId}
    <p class="muted">Rolling for initiative…</p>
  {:else if router.route.name === 'join'}
    <Join code={router.route.code} />
  {:else if router.route.name === 'campaign'}
    {#key router.route.id}
      <Campaign id={router.route.id} {userId} />
    {/key}
  {:else}
    <Home {userId} />
  {/if}
</main>

<style>
  header {
    margin-bottom: 20px;
  }
  .brand {
    font-weight: 800;
    font-size: 1.2rem;
    color: inherit;
    text-decoration: none;
  }
</style>
