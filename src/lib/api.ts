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
  // Also push it to their phone. The nudge already counts if this fails.
  gamemaster({ type: 'nudge_push', campaign_id: campaignId }).catch(() => null);
}

export async function vapidPublicKey(): Promise<string> {
  const { key } = await gamemaster<{ key: string }>({ type: 'vapid_public_key' });
  return key;
}

export async function skipTurn(campaignId: string): Promise<void> {
  await gamemaster({ type: 'skip', campaign_id: campaignId });
}

export async function removePlayer(campaignId: string, playerId: string): Promise<void> {
  await gamemaster({ type: 'remove_player', campaign_id: campaignId, player_id: playerId });
}

export async function myEmail(): Promise<string> {
  return (unwrap(await supabase.rpc('my_email')) as string | null) ?? '';
}

export async function setMyEmail(email: string): Promise<void> {
  unwrap(await supabase.rpc('set_my_email', { new_email: email }));
}

export async function testNotify(campaignId: string): Promise<{ push: string; email: string }> {
  return gamemaster({ type: 'test_notify', campaign_id: campaignId });
}

export async function savePushSubscription(sub: PushSubscriptionJSON): Promise<void> {
  unwrap(
    await supabase.rpc('save_push_subscription', {
      sub_endpoint: sub.endpoint,
      sub_p256dh: sub.keys?.p256dh,
      sub_auth: sub.keys?.auth,
    }),
  );
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

export type CampaignSummary = Campaign & { currentName: string | null; myTurn: boolean; partySize: number };

// The player's campaigns, with whose turn it is. Your turn first.
export async function myCampaigns(userId: string): Promise<CampaignSummary[]> {
  const rows = unwrap(
    await supabase
      .from('players')
      .select('campaigns(*)')
      .eq('user_id', userId)
      .order('joined_at', { ascending: false }),
  ) as unknown as { campaigns: Campaign | null }[];
  const campaigns = rows.map((r) => r.campaigns).filter((c): c is Campaign => c !== null);
  if (!campaigns.length) return [];

  const party = unwrap(
    await supabase
      .from('players')
      .select('id, user_id, name, campaign_id')
      .in(
        'campaign_id',
        campaigns.map((c) => c.id),
      ),
  ) as Pick<Player, 'id' | 'user_id' | 'name' | 'campaign_id'>[];

  const rank = (c: CampaignSummary) => (c.myTurn ? 0 : c.status === 'active' ? 1 : c.status === 'lobby' ? 2 : 3);
  return campaigns
    .map((c) => {
      const current = party.find((p) => p.id === c.current_player_id);
      return {
        ...c,
        currentName: current?.name ?? null,
        myTurn: c.status === 'active' && current?.user_id === userId,
        partySize: party.filter((p) => p.campaign_id === c.id).length,
      };
    })
    .sort((a, b) => rank(a) - rank(b));
}

type Handlers = {
  onCampaign: (c: Campaign) => void;
  onPlayer: (p: Player) => void;
  onPlayerGone: (playerId: string) => void;
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
      { event: 'INSERT', schema: 'public', table: 'players', filter: `campaign_id=eq.${campaignId}` },
      (p) => h.onPlayer(p.new as Player),
    )
    .on(
      'postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'players', filter: `campaign_id=eq.${campaignId}` },
      (p) => h.onPlayer(p.new as Player),
    )
    // Deletes can't be filtered by campaign, so this hears every party's;
    // it only carries the id, and unknown ids are ignored.
    .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'players' }, (p) =>
      h.onPlayerGone((p.old as { id: string }).id),
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
