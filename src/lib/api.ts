import { supabase } from './supabase';
import type { Campaign, LogEntry, Nudge, Player, SettingIdea } from './types';

function unwrap<T>({ data, error }: { data: T | null; error: { message: string } | null }): T {
  if (error) throw new Error(error.message);
  return data as T;
}

export async function createCampaign(campaignName: string, playerName: string): Promise<Campaign> {
  return unwrap(
    await supabase.rpc('create_campaign', { campaign_name: campaignName, player_name: playerName }),
  );
}

export async function joinCampaign(code: string, playerName: string): Promise<Campaign> {
  return unwrap(await supabase.rpc('join_campaign', { join_code: code, player_name: playerName }));
}

export async function updateMyCharacter(campaignId: string, name: string, character: string) {
  unwrap(
    await supabase.rpc('update_my_character', {
      cid: campaignId,
      new_name: name,
      new_character: character,
    }),
  );
}

// d20 rolled in the browser, as the design calls for. Fine among friends.
export function rollD20(): number {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return (buf[0] % 20) + 1;
}

async function gamemaster<T>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke('gamemaster', { body });
  if (!error) return data as T;
  // An HTTP error carries the function's own message; anything else means
  // the function couldn't be reached at all.
  const context = (error as { context?: unknown }).context;
  if (context instanceof Response) {
    const payload = await context.json().catch(() => null);
    if (payload?.error) throw new Error(payload.error);
    if (context.status === 404) throw new Error('The Gamemaster function isn\'t deployed yet.');
    throw new Error(`The Gamemaster replied with an error (${context.status}).`);
  }
  throw new Error("Couldn't reach the Gamemaster. Is the gamemaster function deployed?");
}

export async function takeTurn(campaignId: string, action: string, roll: number): Promise<void> {
  await gamemaster({ campaign_id: campaignId, action, roll });
}

export async function suggestSettings(campaignId: string): Promise<SettingIdea[]> {
  const { settings } = await gamemaster<{ settings: SettingIdea[] }>({
    type: 'suggest_settings',
    campaign_id: campaignId,
  });
  return settings;
}

export async function beginCampaign(campaignId: string, setting: string): Promise<void> {
  await gamemaster({ type: 'begin', campaign_id: campaignId, setting });
}

export async function markSeen(campaignId: string): Promise<void> {
  unwrap(await supabase.rpc('mark_seen', { cid: campaignId }));
}

export async function nudge(campaignId: string): Promise<void> {
  unwrap(await supabase.rpc('nudge', { cid: campaignId }));
}

export async function loadCampaign(campaignId: string) {
  const [campaign, players, log, nudges] = await Promise.all([
    supabase.from('campaigns').select('*').eq('id', campaignId).maybeSingle(),
    supabase.from('players').select('*').eq('campaign_id', campaignId).order('seat'),
    supabase.from('log_entries').select('*').eq('campaign_id', campaignId).order('id'),
    supabase.from('nudges').select('*').eq('campaign_id', campaignId).order('id'),
  ]);
  return {
    campaign: unwrap(campaign) as Campaign | null,
    players: unwrap(players) as Player[],
    log: unwrap(log) as LogEntry[],
    nudges: unwrap(nudges) as Nudge[],
  };
}

export async function myCampaigns(userId: string): Promise<Campaign[]> {
  const rows = unwrap(
    await supabase
      .from('players')
      .select('campaigns(*)')
      .eq('user_id', userId)
      .order('joined_at', { ascending: false }),
  ) as unknown as { campaigns: Campaign | null }[];
  return rows.map((r) => r.campaigns).filter((c): c is Campaign => c !== null);
}

type Handlers = {
  onCampaign: (c: Campaign) => void;
  onPlayer: (p: Player) => void;
  onLog: (e: LogEntry) => void;
  onNudge: (n: Nudge) => void;
  // Player ids with the campaign open right now.
  onOnline: (playerIds: Set<string>) => void;
};

// Live updates for one campaign, plus presence for this player.
// Returns an unsubscribe function.
export function watchCampaign(campaignId: string, myPlayerId: string | undefined, h: Handlers) {
  const channel = supabase
    .channel(`campaign:${campaignId}`, { config: { presence: { key: myPlayerId ?? '' } } })
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'campaigns', filter: `id=eq.${campaignId}` },
      (p) => h.onCampaign(p.new as Campaign),
    )
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'players', filter: `campaign_id=eq.${campaignId}` },
      (p) => h.onPlayer(p.new as Player),
    )
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'log_entries', filter: `campaign_id=eq.${campaignId}` },
      (p) => h.onLog(p.new as LogEntry),
    )
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'nudges', filter: `campaign_id=eq.${campaignId}` },
      (p) => h.onNudge(p.new as Nudge),
    )
    .on('presence', { event: 'sync' }, () => {
      h.onOnline(new Set(Object.keys(channel.presenceState()).filter(Boolean)));
    })
    .subscribe((status) => {
      if (status === 'SUBSCRIBED' && myPlayerId) channel.track({ at: Date.now() });
    });
  return () => {
    supabase.removeChannel(channel);
  };
}
