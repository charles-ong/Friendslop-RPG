export type Campaign = {
  id: string;
  code: string;
  name: string;
  created_by: string;
  status: 'lobby' | 'active' | 'ended';
  turn_number: number;
  current_player_id: string | null;
  gm_busy_since: string | null;
  setting: string | null;
  created_at: string;
};

export type Player = {
  id: string;
  campaign_id: string;
  user_id: string;
  name: string;
  seat: number;
  character: string;
  stats: { hp: number; max_hp: number; [key: string]: unknown };
  joined_at: string;
};

export type LogEntry = {
  id: number;
  campaign_id: string;
  turn_number: number;
  kind: 'system' | 'action' | 'narration';
  player_id: string | null;
  content: string;
  roll: { die: number; result: number } | null;
  created_at: string;
};

export type SettingIdea = { title: string; pitch: string };
