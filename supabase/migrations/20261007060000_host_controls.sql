-- Host controls: skip a turn (the current player can also pass their own)
-- and remove a player. Both run through the Gamemaster function, which then
-- notifies whoever's turn it becomes. Safe to run more than once.

-- Whoever sits after `after_seat`, wrapping back to the lowest seat.
create or replace function public.next_player_after(cid uuid, after_seat integer)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select id from public.players
  where campaign_id = cid
  order by (seat <= after_seat), seat
  limit 1;
$$;

create or replace function public.skip_turn(cid uuid, uid uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  c public.campaigns;
  p public.players;
begin
  select * into c from public.campaigns where id = cid for update;
  if not found or c.status <> 'active' then
    raise exception 'This campaign is not running.';
  end if;

  select * into p from public.players where id = c.current_player_id;
  if c.created_by <> uid and p.user_id is distinct from uid then
    raise exception 'Only the host can skip someone else''s turn.';
  end if;
  if c.gm_busy_since is not null and c.gm_busy_since > now() - interval '2 minutes' then
    raise exception 'The Gamemaster is still narrating.';
  end if;

  insert into public.log_entries (campaign_id, turn_number, kind, content)
  values (
    cid, c.turn_number, 'system',
    case when p.user_id = uid then p.name || ' passed their turn.'
         else p.name || '''s turn was skipped by the host.' end
  );

  update public.campaigns
  set turn_number = c.turn_number + 1,
      current_player_id = public.next_player_after(cid, p.seat),
      gm_busy_since = null
  where id = cid;
end;
$$;

-- Returns true when the removed player had the turn, so it moved on.
create or replace function public.remove_player(cid uuid, uid uuid, pid uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  c public.campaigns;
  target public.players;
  moved boolean := false;
begin
  select * into c from public.campaigns where id = cid for update;
  if not found or c.created_by <> uid then
    raise exception 'Only the host can remove players.';
  end if;

  select * into target from public.players where id = pid and campaign_id = cid;
  if not found then
    raise exception 'That player isn''t in this party.';
  end if;
  if target.user_id = uid then
    raise exception 'The host can''t remove themselves.';
  end if;

  if c.status = 'active' and c.current_player_id = pid then
    if c.gm_busy_since is not null and c.gm_busy_since > now() - interval '2 minutes' then
      raise exception 'Wait for the Gamemaster to finish narrating.';
    end if;
    update public.campaigns
    set turn_number = c.turn_number + 1,
        current_player_id = public.next_player_after(cid, target.seat),
        gm_busy_since = null
    where id = cid;
    moved := true;
  end if;

  delete from public.players where id = pid;

  insert into public.log_entries (campaign_id, turn_number, kind, content)
  values (cid, c.turn_number, 'system', target.name || ' left the party.');

  return moved;
end;
$$;

-- Joining: the 10-player cap counts players, since removals leave gaps in seats.
create or replace function public.join_campaign(join_code text, player_name text)
returns public.campaigns
language plpgsql
security definer
set search_path = public
as $$
declare
  c public.campaigns;
  next_seat integer;
begin
  if auth.uid() is null then
    raise exception 'not signed in';
  end if;

  select * into c from public.campaigns
  where code = upper(trim(join_code))
  for update;

  if not found then
    raise exception 'No campaign with that code.';
  end if;

  -- Rejoining is a no-op, so an invite link can be reopened safely.
  if exists (select 1 from public.players where campaign_id = c.id and user_id = auth.uid()) then
    return c;
  end if;

  if c.status = 'ended' then
    raise exception 'That campaign has ended.';
  end if;

  if (select count(*) from public.players where campaign_id = c.id) >= 10 then
    raise exception 'That party is full (10 players).';
  end if;

  select coalesce(max(seat), 0) + 1 into next_seat
  from public.players where campaign_id = c.id;

  insert into public.players (campaign_id, user_id, name, seat)
  values (c.id, auth.uid(), trim(player_name), next_seat);

  insert into public.log_entries (campaign_id, turn_number, kind, content)
  values (c.id, c.turn_number, 'system', trim(player_name) || ' joined the party.');

  return c;
end;
$$;

revoke all on function public.next_player_after(uuid, integer) from public, anon, authenticated;
revoke all on function public.skip_turn(uuid, uuid) from public, anon, authenticated;
revoke all on function public.remove_player(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.next_player_after(uuid, integer) to service_role;
grant execute on function public.skip_turn(uuid, uuid) to service_role;
grant execute on function public.remove_player(uuid, uuid, uuid) to service_role;

notify pgrst, 'reload schema';
