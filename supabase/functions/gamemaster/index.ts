// The AI Gamemaster. Three requests, by `type`:
//   suggest_settings  host, in the lobby: three setting ideas to pick from
//   begin             host, in the lobby: write the opening scene and start
//   turn (default)    current player: narrate their action and pass the turn
//
// Secrets: GROQ_API_KEY (required), GROQ_MODEL (optional, tried first).

import { createClient } from 'npm:@supabase/supabase-js@2';

// Tried in order; a model the key can't use (404) falls through to the next.
const GROQ_MODELS = [
  Deno.env.get('GROQ_MODEL'),
  'openai/gpt-oss-120b',
  'openai/gpt-oss-20b',
  'llama-3.3-70b-versatile',
].filter((m, i, all): m is string => !!m && all.indexOf(m) === i);
const HISTORY_LIMIT = 30;

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

    return json({ ok: true });
  } catch (e) {
    console.error(e);
    await admin.rpc('abort_turn', { cid: campaignId, action_entry_id: actionId });
    return json({ error: explain(e, 'The Gamemaster lost their notes. Please try again.') }, 502);
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const jwt = req.headers.get('Authorization')?.replace(/^Bearer /, '');
  const { data: auth } = jwt ? await admin.auth.getUser(jwt) : { data: { user: null } };
  if (!auth.user) return json({ error: 'Not signed in.' }, 401);

  const body = await req.json().catch(() => null);
  const campaignId = body?.campaign_id as string | undefined;
  if (!campaignId) return json({ error: 'Send campaign_id.' }, 400);

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
