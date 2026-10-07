-- Pause and nudge: track when each player was last around, and let the
-- waiting party poke whoever's turn it is. Safe to run more than once.

alter table public.players
  add column if not exists last_seen_at timestamptz;

create table if not exists public.nudges (
  id          bigint generated always as identity primary key,
  campaign_id uuid not null references public.campaigns (id) on delete cascade,
  from_player uuid not null references public.players (id) on delete cascade,
  to_player   uuid not null references public.players (id) on delete cascade,
  turn_number integer not null,
  created_at  timestamptz not null default now()
);

create index if not exists nudges_campaign_idx on public.nudges (campaign_id, id);

alter table public.nudges enable row level security;

drop policy if exists "members read nudges" on public.nudges;
create policy "members read nudges" on public.nudges
  for select to authenticated using (public.is_member(campaign_id));

-- Called by the site while a player has the campaign open.
create or replace function public.mark_seen(cid uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update public.players set last_seen_at = now()
  where campaign_id = cid and user_id = auth.uid();
$$;

-- Poke the player whose turn it is. One nudge per sender every 5 minutes.
create or replace function public.nudge(cid uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  c public.campaigns;
  sender public.players;
  target public.players;
begin
  select * into c from public.campaigns where id = cid;
  if not found or c.status <> 'active' or c.current_player_id is null then
    raise exception 'There is no turn to nudge right now.';
  end if;

  select * into sender from public.players where campaign_id = cid and user_id = auth.uid();
  if not found then
    raise exception 'You are not in this party.';
  end if;
  if sender.id = c.current_player_id then
    raise exception 'It is your turn! No need to nudge yourself.';
  end if;

  if exists (
    select 1 from public.nudges
    where from_player = sender.id and created_at > now() - interval '5 minutes'
  ) then
    raise exception 'You nudged recently. Give them a few minutes.';
  end if;

  select * into target from public.players where id = c.current_player_id;

  insert into public.nudges (campaign_id, from_player, to_player, turn_number)
  values (cid, sender.id, target.id, c.turn_number);

  insert into public.log_entries (campaign_id, turn_number, kind, content)
  values (cid, c.turn_number, 'system', sender.name || ' nudged ' || target.name || ' 👉');
end;
$$;

revoke all on function public.mark_seen(uuid) from public, anon;
revoke all on function public.nudge(uuid) from public, anon;
grant execute on function public.mark_seen(uuid) to authenticated;
grant execute on function public.nudge(uuid) to authenticated;

do $$
begin
  alter publication supabase_realtime add table public.nudges;
exception when duplicate_object then
  null;
end;
$$;

notify pgrst, 'reload schema';
