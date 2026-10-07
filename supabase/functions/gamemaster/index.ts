// The AI Gamemaster. The current player posts their action and dice roll;
// this logs it, asks Groq to narrate, records the result and passes the turn.
//
// Secrets: GROQ_API_KEY (required), GROQ_MODEL (optional).

import { createClient } from 'npm:@supabase/supabase-js@2';

const GROQ_MODEL = Deno.env.get('GROQ_MODEL') ?? 'llama-3.3-70b-versatile';
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

async function narrate(messages: { role: string; content: string }[]) {
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${Deno.env.get('GROQ_API_KEY')}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages,
      temperature: 0.9,
      max_tokens: 700,
      response_format: { type: 'json_object' },
    }),
  });
  if (!res.ok) throw new Error(`Groq ${res.status}: ${await res.text()}`);

  const data = await res.json();
  const parsed = JSON.parse(data.choices[0].message.content);
  if (typeof parsed.narration !== 'string' || !parsed.narration.trim()) {
    throw new Error('Gamemaster returned no narration.');
  }
  return {
    narration: parsed.narration.trim() as string,
    hpChanges: (Array.isArray(parsed.hp_changes) ? parsed.hp_changes : []) as { name: string; delta: number }[],
  };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const jwt = req.headers.get('Authorization')?.replace(/^Bearer /, '');
  const { data: auth } = jwt ? await admin.auth.getUser(jwt) : { data: { user: null } };
  if (!auth.user) return json({ error: 'Not signed in.' }, 401);

  const body = await req.json().catch(() => null);
  const campaignId = body?.campaign_id as string | undefined;
  const action = (body?.action as string | undefined)?.trim().slice(0, 500);
  const result = Number(body?.roll);
  if (!campaignId || !action || !Number.isInteger(result) || result < 1 || result > 20) {
    return json({ error: 'Send campaign_id, action and a d20 roll.' }, 400);
  }
  const roll = { die: 20, result };

  const { data: actionId, error: beginError } = await admin.rpc('begin_turn', {
    cid: campaignId,
    uid: auth.user.id,
    action,
    roll,
  });
  if (beginError) return json({ error: beginError.message }, 409);

  try {
    const [{ data: campaign }, { data: players }, { data: history }] = await Promise.all([
      admin.from('campaigns').select('name, current_player_id').eq('id', campaignId).single(),
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
      buildMessages(campaign!.name, party, (history as Entry[]).reverse(), actor, next, action, roll),
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
    return json({ error: 'The Gamemaster lost their notes. Please try again.' }, 502);
  }
});
