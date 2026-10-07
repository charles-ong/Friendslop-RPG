-- Opening setting: the host picks (or writes) a setting, the Gamemaster
-- writes an opening scene, and only then does the campaign go active.

alter table public.campaigns
  add column setting text;

-- Starting now goes through the Gamemaster function, which needs the setting.
drop function if exists public.start_campaign(uuid);

create or replace function public.begin_campaign(cid uuid, uid uuid, new_setting text, opening text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  first_player uuid;
begin
  select id into first_player from public.players
  where campaign_id = cid order by seat limit 1;

  update public.campaigns
  set status = 'active', setting = new_setting, turn_number = 1, current_player_id = first_player
  where id = cid and created_by = uid and status = 'lobby';

  if not found then
    raise exception 'Only the host can start a campaign that is still in the lobby.';
  end if;

  insert into public.log_entries (campaign_id, turn_number, kind, content)
  values (cid, 1, 'system', 'The adventure begins!');

  insert into public.log_entries (campaign_id, turn_number, kind, content)
  values (cid, 1, 'narration', opening);
end;
$$;

revoke all on function public.begin_campaign(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.begin_campaign(uuid, uuid, text, text) to service_role;
