import { supabase } from './supabase';
import type { Campaign, LogEntry, Player } from './types';

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

export async function startCampaign(campaignId: string): Promise<void> {
  unwrap(await supabase.rpc('start_campaign', { cid: campaignId }));
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

export async function loadCampaign(campaignId: string) {
  const [campaign, players, log] = await Promise.all([
    supabase.from('campaigns').select('*').eq('id', campaignId).maybeSingle(),
    supabase.from('players').select('*').eq('campaign_id', campaignId).order('seat'),
    supabase.from('log_entries').select('*').eq('campaign_id', campaignId).order('id'),
  ]);
  return {
    campaign: unwrap(campaign) as Campaign | null,
    players: unwrap(players) as Player[],
    log: unwrap(log) as LogEntry[],
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
};

// Live updates for one campaign. Returns an unsubscribe function.
export function watchCampaign(campaignId: string, h: Handlers) {
  const channel = supabase
    .channel(`campaign:${campaignId}`)
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
    .subscribe();
  return () => {
    supabase.removeChannel(channel);
  };
}
