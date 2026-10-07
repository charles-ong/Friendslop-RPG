// The AI Gamemaster. Requests, by `type`:
//   suggest_settings  host, in the lobby: three setting ideas to pick from
//   begin             host, in the lobby: write the opening scene and start
//   turn (default)    current player: narrate their action and pass the turn
//   vapid_public_key  anyone signed in: the key browsers need to subscribe to Web Push
//   nudge_push        after the `nudge` RPC: notify that nudge's target
//   test_notify       anyone signed in: send themselves a test, report what happened
//   skip              host (or the current player): pass the turn to the next seat
//   remove_player     host: remove a player, passing the turn on if it was theirs
//
// Whenever the turn passes to someone, or they're nudged, they get a Web Push
// notification, plus an email if they left an address and aren't on the site.
// The VAPID keys for push are created on first use and kept in app_secrets.
//
// Secrets: GROQ_API_KEY (required), GROQ_MODEL (optional, tried first),
// BREVO_API_KEY and BREVO_SENDER (optional, for email), SITE_URL (optional).

import { createClient } from 'npm:@supabase/supabase-js@2';
import {
  ApplicationServer,
  exportApplicationServerKey,
  exportVapidKeys,
  generateVapidKeys,
  importVapidKeys,
  PushMessageError,
  Urgency,
} from 'jsr:@negrel/webpush@0.5.0';

// Tried in order; a model the key can't use (404) falls through to the next.
const GROQ_MODELS = [
  Deno.env.get('GROQ_MODEL'),
  'openai/gpt-oss-120b',
  'openai/gpt-oss-20b',
  'llama-3.3-70b-versatile',
].filter((m, i, all): m is string => !!m && all.indexOf(m) === i);
const HISTORY_LIMIT = 30;
const SITE_URL = Deno.env.get('SITE_URL') ?? 'https://charles-ong.github.io/Friendslop-RPG/';
// Someone seen this recently has the site open, so an email would be noise.
const EMAIL_IF_AWAY_MS = 2 * 60_000;

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });
}

function serviceKey(): string {
  try {
    const keys = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') ?? '{}');
    if (keys.default) return keys.default;
  } catch {
    // fall through to the legacy key
  }
  return Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
}

const admin = createClient(Deno.env.get('SUPABASE_URL')!, serviceKey(), {
  auth: { persistSession: false },
});

type Player = { id: string; name: string; seat: number; character: string; stats: { hp: number; max_hp: number } };
type Entry = { kind: string; player_id: string | null; content: string; roll: { die: number; result: number } | null };

const SYSTEM_PROMPT = `You are the Gamemaster of a cozy-but-dangerous fantasy text RPG played by a small group of friends, one turn at a time.

Style:
- Warm, playful, character-focused storytelling with real stakes. Cute, never grim or gory.
- 1 to 3 short paragraphs. Second person for the acting player ("you"), names for everyone else.
- Keep one consistent world and remember what happened earlier in the log.

Rules:
- The player describes what they TRY to do. The d20 roll decides how well it goes: 1 is a funny disaster, 2-7 fails with a complication, 8-13 partly succeeds, 14-19 succeeds, 20 is a spectacular success.
- Never take actions on behalf of other players. Leave space for them.
- End by turning the spotlight to the next player with a short prompt for what they might do.
- Only change HP when something in the story clearly causes harm or healing; keep changes small (usually 1 to 3).

Reply with JSON only: {"narration": string, "hp_changes": [{"name": string, "delta": integer}]}`;

function describeRoll(roll: Entry['roll']) {
  return roll ? ` [rolled d${roll.die}: ${roll.result}]` : '';
}

function buildMessages(
  campaignName: string,
  setting: string | null,
  players: Player[],
  history: Entry[],
  actor: Player,
  next: Player,
  action: string,
  roll: { die: number; result: number },
) {
  const nameOf = (id: string | null) => players.find((p) => p.id === id)?.name ?? 'Someone';
  const party = players
    .map((p) => `- ${p.name} (HP ${p.stats.hp}/${p.stats.max_hp})${p.character ? `: ${p.character}` : ''}`)
    .join('\n');
  const log = history
    .map((e) =>
      e.kind === 'action'
        ? `${nameOf(e.player_id)}: ${e.content}${describeRoll(e.roll)}`
        : e.kind === 'narration'
          ? `GM: ${e.content}`
          : `(${e.content})`,
    )
    .join('\n');

  const user = `Campaign: ${campaignName}
${setting ? `Setting: ${setting}\n` : ''}
Party:
${party}

Story so far:
${log || '(This is the very first turn. Open the adventure with a hook that fits the party.)'}

Now it's ${actor.name}'s turn.
${actor.name}: ${action}${describeRoll(roll)}

The next player is ${next.name}.`;

  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: user },
  ];
}

async function chat(messages: { role: string; content: string }[], maxTokens = 700) {
  let lastError = '';
  for (const model of GROQ_MODELS) {
    // gpt-oss models reason before answering; keep that short and out of the reply.
    const reasoning = model.startsWith('openai/gpt-oss')
      ? { reasoning_effort: 'low', include_reasoning: false }
      : {};
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${Deno.env.get('GROQ_API_KEY')}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0.9,
        max_completion_tokens: reasoning.reasoning_effort ? maxTokens + 1500 : maxTokens,
        response_format: { type: 'json_object' },
        ...reasoning,
      }),
    });
    if (res.status === 404) {
      lastError = `Groq 404: ${await res.text()}`;
      continue;
    }
    if (!res.ok) throw new Error(`Groq ${res.status}: ${await res.text()}`);

    const data = await res.json();
    return JSON.parse(data.choices[0].message.content);
  }
  throw new Error(lastError);
}

async function narrate(messages: { role: string; content: string }[]) {
  const parsed = await chat(messages);
  if (typeof parsed.narration !== 'string' || !parsed.narration.trim()) {
    throw new Error('Gamemaster returned no narration.');
  }
  return {
    narration: parsed.narration.trim() as string,
    hpChanges: (Array.isArray(parsed.hp_changes) ? parsed.hp_changes : []) as { name: string; delta: number }[],
  };
}

// Turn a failure into something the players (or the host setting things up) can act on.
// Unrecognised errors keep a short detail so setup problems can be diagnosed.
function explain(e: unknown, fallback: string): string {
  const message = String((e as { message?: unknown })?.message ?? e);
  if (message.startsWith('Only the host')) return message;

  if (!Deno.env.get('GROQ_API_KEY') || message.startsWith('Groq 401')) {
    return 'The Groq API key is missing or invalid. Check the GROQ_API_KEY secret in Supabase.';
  }
  if (message.startsWith('Groq 429')) return 'Groq is rate limiting us. Wait a minute and try again.';
  if (message.startsWith('Groq ')) {
    const status = message.slice(5, 8);
    let detail = '';
    try {
      detail = JSON.parse(message.slice(message.indexOf('{'))).error?.message ?? '';
    } catch {
      // not JSON
    }
    return `Groq returned an error (${status})${detail ? `: ${detail}` : ''}`.slice(0, 300);
  }

  const code = (e as { code?: unknown })?.code;
  if (code === 'PGRST202' || message.includes('schema cache')) {
    return 'The database is missing an update. Run the newest SQL file in supabase/migrations.';
  }
  return `${fallback} (${message.slice(0, 200)})`;
}

function partyLines(players: Player[]) {
  return players
    .map((p) => `- ${p.name}${p.character ? `: ${p.character}` : ''}`)
    .join('\n');
}

async function loadLobby(campaignId: string, userId: string) {
  const [{ data: campaign }, { data: players }] = await Promise.all([
    admin.from('campaigns').select('name, status, created_by').eq('id', campaignId).maybeSingle(),
    admin.from('players').select('id, name, seat, character, stats').eq('campaign_id', campaignId).order('seat'),
  ]);
  if (!campaign || campaign.created_by !== userId || campaign.status !== 'lobby') {
    throw new Error('Only the host can do that, before the adventure starts.');
  }
  return { name: campaign.name as string, players: players as Player[] };
}

async function suggestSettings(campaignId: string, userId: string) {
  const { name, players } = await loadLobby(campaignId, userId);
  const parsed = await chat(
    [
      {
        role: 'system',
        content: `You pitch settings for a cozy-but-dangerous fantasy text RPG played by friends. Make the three pitches clearly different from each other in place, tone and genre flavour (for example: whimsical, mysterious, swashbuckling). Each has a short evocative title and a 2-sentence pitch that hints at a first problem to solve. Fit them to the party if their characters suggest anything.

Reply with JSON only: {"settings": [{"title": string, "pitch": string}, ...three items]}`,
      },
      { role: 'user', content: `Campaign name: ${name}\n\nParty:\n${partyLines(players)}` },
    ],
    500,
  );
  const settings = (Array.isArray(parsed.settings) ? parsed.settings : [])
    .filter((s: { title?: unknown; pitch?: unknown }) => typeof s?.title === 'string' && typeof s?.pitch === 'string')
    .slice(0, 3);
  if (settings.length === 0) throw new Error('No settings came back.');
  return { settings };
}

async function begin(campaignId: string, userId: string, setting: string) {
  const { name, players } = await loadLobby(campaignId, userId);
  const first = players[0];
  const { narration } = await narrate([
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content: `Campaign: ${name}
Setting: ${setting}

Party:
${partyLines(players)}

Write the opening scene. Set the place and mood in a vivid but short way, bring the party together, and present a first situation or problem. Nobody has acted yet, so don't decide anything for the players. End by turning the spotlight to ${first.name}, who goes first. Use "hp_changes": [].`,
    },
  ]);

  const { error } = await admin.rpc('begin_campaign', {
    cid: campaignId,
    uid: userId,
    new_setting: setting,
    opening: narration,
  });
  if (error) throw error;
  await pushTurn(campaignId);
  return { ok: true };
}

async function takeTurn(campaignId: string, userId: string, action: string, result: number) {
  const roll = { die: 20, result };

  const { data: actionId, error: beginError } = await admin.rpc('begin_turn', {
    cid: campaignId,
    uid: userId,
    action,
    roll,
  });
  if (beginError) return json({ error: beginError.message }, 409);

  try {
    const [{ data: campaign }, { data: players }, { data: history }] = await Promise.all([
      admin.from('campaigns').select('name, setting, current_player_id').eq('id', campaignId).single(),
      admin.from('players').select('id, name, seat, character, stats').eq('campaign_id', campaignId).order('seat'),
      admin
        .from('log_entries')
        .select('kind, player_id, content, roll')
        .eq('campaign_id', campaignId)
        .lt('id', actionId)
        .order('id', { ascending: false })
        .limit(HISTORY_LIMIT),
    ]);

    const party = players as Player[];
    const actor = party.find((p) => p.id === campaign!.current_player_id)!;
    const next = party.find((p) => p.seat > actor.seat) ?? party[0];

    const { narration, hpChanges } = await narrate(
      buildMessages(
        campaign!.name,
        campaign!.setting,
        party,
        (history as Entry[]).reverse(),
        actor,
        next,
        action,
        roll,
      ),
    );

    const changes = hpChanges
      .map((c) => ({
        player_id: party.find((p) => p.name.toLowerCase() === String(c.name).toLowerCase())?.id,
        delta: Math.max(-5, Math.min(5, Math.trunc(Number(c.delta) || 0))),
      }))
      .filter((c) => c.player_id && c.delta !== 0);

    const { error: finishError } = await admin.rpc('finish_turn', {
      cid: campaignId,
      narration,
      hp_changes: changes,
    });
    if (finishError) throw finishError;

    await pushTurn(campaignId);
    return json({ ok: true });
  } catch (e) {
    console.error(e);
    await admin.rpc('abort_turn', { cid: campaignId, action_entry_id: actionId });
    return json({ error: explain(e, 'The Gamemaster lost their notes. Please try again.') }, 502);
  }
}

// --- Notifications: Web Push and email -------------------------------------------------------------

let appServer: Promise<{ server: ApplicationServer; publicKey: string }> | null = null;

async function loadVapidKeys() {
  const { data, error } = await admin.from('app_secrets').select('value').eq('name', 'vapid').maybeSingle();
  if (error) throw error;
  if (data) return importVapidKeys(data.value, { extractable: false });

  const fresh = await exportVapidKeys(await generateVapidKeys({ extractable: true }));
  // Two first requests at once: whichever insert lands wins, both use it.
  await admin.from('app_secrets').upsert({ name: 'vapid', value: fresh }, { onConflict: 'name', ignoreDuplicates: true });
  const { data: saved, error: again } = await admin.from('app_secrets').select('value').eq('name', 'vapid').single();
  if (again) throw again;
  return importVapidKeys(saved.value, { extractable: false });
}

function getAppServer() {
  appServer ??= (async () => {
    const vapidKeys = await loadVapidKeys();
    return {
      server: await ApplicationServer.new({ contactInformation: 'mailto:friendslop-rpg@users.noreply.github.com', vapidKeys }),
      publicKey: await exportApplicationServerKey(vapidKeys),
    };
  })();
  appServer.catch(() => (appServer = null));
  return appServer;
}

// `url` is a hash route; the service worker resolves it against the site.
type Notice = { title: string; body: string; url: string; tag: string };

// Best-effort: a failed notification never fails the request that triggered it.
// Each returns a short report, which test_notify shows to the player.
async function pushToUser(userId: string, message: Notice): Promise<string> {
  try {
    const { data: subs, error } = await admin
      .from('push_subscriptions')
      .select('endpoint, p256dh, auth')
      .eq('user_id', userId);
    if (error) throw error;
    if (!subs?.length) return 'no device has notifications turned on';

    const { server } = await getAppServer();
    const results = await Promise.all(
      subs.map(async (s) => {
        try {
          const subscriber = server.subscribe({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } });
          await subscriber.pushTextMessage(JSON.stringify(message), {
            urgency: Urgency.High,
            ttl: 60 * 60 * 24,
            topic: message.tag.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32),
          });
          return null;
        } catch (e) {
          if (e instanceof PushMessageError && (e.isGone() || e.response.status === 404)) {
            await admin.from('push_subscriptions').delete().eq('endpoint', s.endpoint);
            return 'a device had expired and was removed';
          }
          console.error('push failed', e);
          const status = e instanceof PushMessageError ? ` ${e.response.status}` : '';
          return `push service error${status}: ${String((e as Error)?.message ?? e).slice(0, 120)}`;
        }
      }),
    );
    const failures = results.filter((r): r is string => !!r);
    const sent = results.length - failures.length;
    return [sent ? `sent to ${sent} device${sent === 1 ? '' : 's'}` : '', ...failures].filter(Boolean).join('; ');
  } catch (e) {
    console.error('push skipped', e);
    return `couldn't push: ${explain(e, 'unexpected error')}`;
  }
}

async function emailToUser(userId: string, message: Notice): Promise<string> {
  const apiKey = Deno.env.get('BREVO_API_KEY');
  const sender = Deno.env.get('BREVO_SENDER');
  if (!apiKey || !sender) return 'email isn\'t set up on the server yet';
  try {
    const { data, error } = await admin.from('notify_emails').select('email').eq('user_id', userId).maybeSingle();
    if (error) throw error;
    if (!data) return 'no email address saved';

    const link = new URL(message.url, SITE_URL).href;
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': apiKey, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        sender: { email: sender, name: 'Friendslop RPG' },
        to: [{ email: data.email }],
        subject: message.title,
        textContent: `${message.body}\n\nJump back in: ${link}\n\n(You get this because you left your email in Friendslop RPG. Clear it on your campaign page to stop.)`,
        htmlContent: `<p>${escapeHtml(message.body)}</p><p><a href="${escapeHtml(link)}">Jump back in 🎲</a></p><p style="color:#8a8197;font-size:12px">You get this because you left your email in Friendslop RPG. Clear it on your campaign page to stop.</p>`,
      }),
    });
    if (!res.ok) {
      const detail = await res.text();
      console.error('email failed', res.status, detail);
      return `email service error ${res.status}: ${detail.slice(0, 160)}`;
    }
    return `emailed ${data.email}`;
  } catch (e) {
    console.error('email skipped', e);
    return `couldn't email: ${explain(e, 'unexpected error')}`;
  }
}

function escapeHtml(text: string) {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

async function notifyPlayer(playerId: string, message: Notice) {
  const { data: player } = await admin
    .from('players')
    .select('user_id, last_seen_at')
    .eq('id', playerId)
    .maybeSingle();
  if (!player) return;
  const away = !player.last_seen_at || Date.now() - Date.parse(player.last_seen_at) > EMAIL_IF_AWAY_MS;
  await Promise.all([pushToUser(player.user_id, message), away ? emailToUser(player.user_id, message) : null]);
}

async function pushTurn(campaignId: string) {
  const { data: campaign } = await admin
    .from('campaigns')
    .select('name, current_player_id')
    .eq('id', campaignId)
    .maybeSingle();
  if (!campaign?.current_player_id) return;
  const { data: player } = await admin.from('players').select('name').eq('id', campaign.current_player_id).maybeSingle();
  await notifyPlayer(campaign.current_player_id, {
    title: `Your turn in ${campaign.name} 🎲`,
    body: `${player?.name ?? 'Adventurer'}, the party is waiting on you.`,
    url: `#/c/${campaignId}`,
    tag: `turn-${campaignId}`,
  });
}

async function pushNudge(campaignId: string, userId: string) {
  const { data: sender } = await admin
    .from('players')
    .select('id, name')
    .eq('campaign_id', campaignId)
    .eq('user_id', userId)
    .maybeSingle();
  if (!sender) return;

  // Claim this sender's newest unsent nudge, so each nudge notifies at most once.
  const { data: latest } = await admin
    .from('nudges')
    .select('id')
    .eq('from_player', sender.id)
    .is('pushed_at', null)
    .gt('created_at', new Date(Date.now() - 60_000).toISOString())
    .order('id', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!latest) return;
  const { data: claimed } = await admin
    .from('nudges')
    .update({ pushed_at: new Date().toISOString() })
    .eq('id', latest.id)
    .is('pushed_at', null)
    .select('to_player')
    .maybeSingle();
  if (!claimed) return;
  const { data: campaign } = await admin.from('campaigns').select('name').eq('id', campaignId).maybeSingle();

  await notifyPlayer(claimed.to_player, {
    title: `${sender.name} nudged you 👉`,
    body: `It's your turn in ${campaign?.name ?? 'your adventure'}.`,
    url: `#/c/${campaignId}`,
    tag: `turn-${campaignId}`,
  });
}

async function testNotify(userId: string, campaignId: string | undefined) {
  const message = {
    title: 'Test from Friendslop RPG 🎲',
    body: 'Notifications work! This is what your turn alerts will look like.',
    url: campaignId ? `#/c/${campaignId}` : '#/',
    tag: 'friendslop-test',
  };
  const [push, email] = await Promise.all([pushToUser(userId, message), emailToUser(userId, message)]);
  return { push, email };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const jwt = req.headers.get('Authorization')?.replace(/^Bearer /, '');
  const { data: auth } = jwt ? await admin.auth.getUser(jwt) : { data: { user: null } };
  if (!auth.user) return json({ error: 'Not signed in.' }, 401);

  const body = await req.json().catch(() => null);

  if (body?.type === 'vapid_public_key') {
    try {
      return json({ key: (await getAppServer()).publicKey });
    } catch (e) {
      console.error(e);
      return json({ error: explain(e, "Couldn't set up notifications.") }, 502);
    }
  }

  const campaignId = body?.campaign_id as string | undefined;
  if (body?.type === 'test_notify') return json(await testNotify(auth.user.id, campaignId));
  if (!campaignId) return json({ error: 'Send campaign_id.' }, 400);

  if (body.type === 'skip' || body.type === 'remove_player') {
    const { data: moved, error } =
      body.type === 'skip'
        ? await admin.rpc('skip_turn', { cid: campaignId, uid: auth.user.id }).then((r) => ({ ...r, data: true }))
        : await admin.rpc('remove_player', { cid: campaignId, uid: auth.user.id, pid: String(body.player_id ?? '') });
    if (error) {
      console.error(error);
      const code = (error as { code?: string }).code;
      // P0001 is a `raise exception` with a message meant for players.
      return json({ error: code === 'P0001' ? error.message : explain(error, 'That didn\'t work.') }, 409);
    }
    if (moved) await pushTurn(campaignId);
    return json({ ok: true });
  }

  if (body.type === 'nudge_push') {
    await pushNudge(campaignId, auth.user.id);
    return json({ ok: true });
  }

  if (body.type === 'suggest_settings' || body.type === 'begin') {
    const setting = String(body.setting ?? '').trim().slice(0, 600);
    if (body.type === 'begin' && !setting) return json({ error: 'Pick or write a setting first.' }, 400);
    try {
      return json(
        body.type === 'begin'
          ? await begin(campaignId, auth.user.id, setting)
          : await suggestSettings(campaignId, auth.user.id),
      );
    } catch (e) {
      console.error(e);
      return json({ error: explain(e, 'The Gamemaster got distracted. Please try again.') }, 502);
    }
  }

  const action = (body.action as string | undefined)?.trim().slice(0, 500);
  const result = Number(body.roll);
  if (!action || !Number.isInteger(result) || result < 1 || result > 20) {
    return json({ error: 'Send an action and a d20 roll.' }, 400);
  }
  return takeTurn(campaignId, auth.user.id, action, result);
});
