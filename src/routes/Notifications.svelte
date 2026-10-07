<script lang="ts">
  import { onMount } from 'svelte';
  import { alertsSupported, enableAlerts, needsHomeScreen, subscribeToPush } from '../lib/alerts';
  import { myEmail, setMyEmail, testNotify } from '../lib/api';

  let { campaignId, alertsOn = $bindable() }: { campaignId: string; alertsOn: boolean } = $props();

  let email = $state('');
  let savedEmail = $state('');
  let saving = $state(false);
  let testing = $state(false);
  let report = $state<string[]>([]);
  let error = $state('');

  onMount(() => {
    myEmail()
      .then((e) => (email = savedEmail = e))
      .catch(() => {});
  });

  async function turnOn() {
    alertsOn = await enableAlerts();
  }

  async function saveEmail(event: SubmitEvent) {
    event.preventDefault();
    saving = true;
    error = '';
    try {
      await setMyEmail(email.trim());
      savedEmail = email.trim().toLowerCase();
      email = savedEmail;
    } catch (e) {
      error = (e as Error).message;
    } finally {
      saving = false;
    }
  }

  async function sendTest() {
    testing = true;
    error = '';
    report = [];
    try {
      const lines: string[] = [];
      if (alertsOn) {
        const problem = await subscribeToPush();
        if (problem) lines.push(`This device: ${problem}`);
      }
      const result = await testNotify(campaignId);
      lines.push(`Push: ${result.push}`, `Email: ${result.email}`);
      report = lines;
    } catch (e) {
      error = (e as Error).message;
    } finally {
      testing = false;
    }
  }
</script>

<section class="card">
  <h2>Notifications</h2>
  <p class="muted">Get a ping when it's your turn or someone nudges you, even with this page closed.</p>

  {#if alertsOn}
    <p>🔔 Notifications are on for this device.</p>
  {:else if alertsSupported()}
    <button class="ghost" onclick={turnOn}>🔔 Turn on notifications on this device</button>
  {:else if needsHomeScreen()}
    <p class="muted">
      On iPhone, tap Share → <strong>Add to Home Screen</strong>, then open Friendslop from there to turn on
      notifications. Or use email below.
    </p>
  {:else}
    <p class="muted">This browser can't show notifications. Email works anywhere.</p>
  {/if}

  <form onsubmit={saveEmail}>
    <label for="nemail">Email me when I'm away <span class="muted">(only you can see this)</span></label>
    <div class="row">
      <input id="nemail" type="email" bind:value={email} placeholder="you@example.com" maxlength="254" />
      <button disabled={saving || email.trim().toLowerCase() === savedEmail}>
        {saving ? 'Saving…' : email.trim() || !savedEmail ? 'Save' : 'Remove'}
      </button>
    </div>
  </form>

  <button class="ghost test" onclick={sendTest} disabled={testing}>
    {testing ? 'Sending…' : 'Send me a test'}
  </button>
  {#if report.length}
    <ul class="report">
      {#each report as line}<li>{line}</li>{/each}
    </ul>
  {/if}
  {#if error}<p class="error">{error}</p>{/if}
</section>

<style>
  .test {
    margin-top: 12px;
  }
  .report {
    margin: 10px 0 0;
    padding-left: 18px;
    font-size: 0.9rem;
  }
</style>
