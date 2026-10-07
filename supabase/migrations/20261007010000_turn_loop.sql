-- Turn loop: the current player submits an action, the Gamemaster edge
-- function narrates it, and the turn passes to the next seat.
-- These functions are only callable with the service role (the edge function).

alter table public.campaigns
  add column gm_busy_since timestamptz;

-- Claims the turn for narration and logs the player's action.
-- Fails if it isn't this user's turn or the Gamemaster is already working.
create or replace function public.begin_turn(cid uuid, uid uuid, action text, roll jsonb)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  c public.campaigns;
  p public.players;
  entry_id bigint;
begin
  select * into c from public.campaigns where id = cid for update;
  if not found or c.status <> 'active' then
    raise exception 'This campaign is not running.';
  end if;

  select * into p from public.players where id = c.current_player_id;
  if p.user_id is distinct from uid then
    raise exception 'It is not your turn.';
  end if;

  -- A stuck claim (the function crashed) expires after two minutes.
  if c.gm_busy_since is not null and c.gm_busy_since > now() - interval '2 minutes' then
    raise exception 'The Gamemaster is still narrating.';
  end if;

  update public.campaigns set gm_busy_since = now() where id = cid;

  insert into public.log_entries (campaign_id, turn_number, kind, player_id, content, roll)
  values (cid, c.turn_number, 'action', p.id, action, roll)
  returning id into entry_id;

  return entry_id;
end;
$$;

-- Undo a claimed turn when narration fails, so the player can try again.
create or replace function public.abort_turn(cid uuid, action_entry_id bigint)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.log_entries where id = action_entry_id and campaign_id = cid;
  update public.campaigns set gm_busy_since = null where id = cid;
end;
$$;

-- Records the narration, applies HP changes, and passes the turn on.
-- hp_changes looks like [{"player_id": "...", "delta": -2}].
create or replace function public.finish_turn(cid uuid, narration text, hp_changes jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  c public.campaigns;
  change jsonb;
  current_seat integer;
  next_player uuid;
begin
  select * into c from public.campaigns where id = cid for update;

  insert into public.log_entries (campaign_id, turn_number, kind, content)
  values (cid, c.turn_number, 'narration', narration);

  for change in select * from jsonb_array_elements(coalesce(hp_changes, '[]'::jsonb)) loop
    update public.players
    set stats = jsonb_set(
      stats, '{hp}',
      to_jsonb(greatest(0, least(
        (stats->>'max_hp')::int,
        (stats->>'hp')::int + coalesce((change->>'delta')::int, 0)
      )))
    )
    where id = (change->>'player_id')::uuid and campaign_id = cid;
  end loop;

  select seat into current_seat from public.players where id = c.current_player_id;

  -- Next seat around the table, wrapping back to the lowest.
  select id into next_player from public.players
  where campaign_id = cid
  order by (seat <= current_seat), seat
  limit 1;

  update public.campaigns
  set turn_number = c.turn_number + 1,
      current_player_id = next_player,
      gm_busy_since = null
  where id = cid;
end;
$$;

revoke all on function public.begin_turn(uuid, uuid, text, jsonb) from public, anon, authenticated;
revoke all on function public.abort_turn(uuid, bigint) from public, anon, authenticated;
revoke all on function public.finish_turn(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.begin_turn(uuid, uuid, text, jsonb) to service_role;
grant execute on function public.abort_turn(uuid, bigint) to service_role;
grant execute on function public.finish_turn(uuid, text, jsonb) to service_role;
