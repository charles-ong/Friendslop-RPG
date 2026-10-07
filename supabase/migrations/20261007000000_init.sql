-- Friendslop RPG: initial schema.
-- Players sign in anonymously, so auth.uid() identifies a browser.
-- Clients only read tables directly; every write goes through a
-- security-definer function (or, later, the Gamemaster edge function).

create extension if not exists pgcrypto;

-- Tables ---------------------------------------------------------------

create table public.campaigns (
  id          uuid primary key default gen_random_uuid(),
  code        text not null unique,
  name        text not null check (char_length(name) between 1 and 60),
  created_by  uuid not null references auth.users (id) on delete cascade,
  status      text not null default 'lobby' check (status in ('lobby', 'active', 'ended')),
  turn_number integer not null default 0,
  current_player_id uuid,
  created_at  timestamptz not null default now()
);

create table public.players (
  id          uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.campaigns (id) on delete cascade,
  user_id     uuid not null references auth.users (id) on delete cascade,
  name        text not null check (char_length(name) between 1 and 24),
  seat        integer not null,
  character   text not null default '' check (char_length(character) <= 280),
  stats       jsonb not null default '{"hp": 10, "max_hp": 10}'::jsonb,
  joined_at   timestamptz not null default now(),
  unique (campaign_id, user_id),
  unique (campaign_id, seat)
);

alter table public.campaigns
  add constraint campaigns_current_player_fk
  foreign key (current_player_id) references public.players (id) on delete set null;

create table public.log_entries (
  id          bigint generated always as identity primary key,
  campaign_id uuid not null references public.campaigns (id) on delete cascade,
  turn_number integer not null,
  kind        text not null check (kind in ('system', 'action', 'narration')),
  player_id   uuid references public.players (id) on delete set null,
  content     text not null,
  roll        jsonb,
  created_at  timestamptz not null default now()
);

create index log_entries_campaign_idx on public.log_entries (campaign_id, id);
create index players_user_idx on public.players (user_id);

-- Row level security ---------------------------------------------------

alter table public.campaigns   enable row level security;
alter table public.players     enable row level security;
alter table public.log_entries enable row level security;

-- Security definer so the players policy can check membership without
-- recursing into itself.
create or replace function public.is_member(cid uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.players
    where campaign_id = cid and user_id = auth.uid()
  );
$$;

create policy "members read campaigns" on public.campaigns
  for select to authenticated using (public.is_member(id));

create policy "members read players" on public.players
  for select to authenticated using (public.is_member(campaign_id));

create policy "members read log" on public.log_entries
  for select to authenticated using (public.is_member(campaign_id));

-- Functions ------------------------------------------------------------

-- Six characters from an alphabet without look-alikes (no 0/O, 1/I/L).
create or replace function public.new_campaign_code()
returns text
language plpgsql
as $$
declare
  alphabet constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  result text;
begin
  loop
    result := '';
    for i in 1..6 loop
      result := result || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
    end loop;
    exit when not exists (select 1 from public.campaigns where code = result);
  end loop;
  return result;
end;
$$;

create or replace function public.create_campaign(campaign_name text, player_name text)
returns public.campaigns
language plpgsql
security definer
set search_path = public
as $$
declare
  c public.campaigns;
begin
  if auth.uid() is null then
    raise exception 'not signed in';
  end if;

  insert into public.campaigns (code, name, created_by)
  values (public.new_campaign_code(), trim(campaign_name), auth.uid())
  returning * into c;

  insert into public.players (campaign_id, user_id, name, seat)
  values (c.id, auth.uid(), trim(player_name), 1);

  insert into public.log_entries (campaign_id, turn_number, kind, content)
  values (c.id, 0, 'system', trim(player_name) || ' started the campaign.');

  return c;
end;
$$;

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

  select coalesce(max(seat), 0) + 1 into next_seat
  from public.players where campaign_id = c.id;

  if next_seat > 10 then
    raise exception 'That party is full (10 players).';
  end if;

  insert into public.players (campaign_id, user_id, name, seat)
  values (c.id, auth.uid(), trim(player_name), next_seat);

  insert into public.log_entries (campaign_id, turn_number, kind, content)
  values (c.id, c.turn_number, 'system', trim(player_name) || ' joined the party.');

  return c;
end;
$$;

create or replace function public.update_my_character(cid uuid, new_name text, new_character text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.players
  set name = trim(new_name), character = trim(new_character)
  where campaign_id = cid and user_id = auth.uid();
end;
$$;

-- Only the creator can start, and only from the lobby. Seat 1 goes first.
create or replace function public.start_campaign(cid uuid)
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
  set status = 'active', turn_number = 1, current_player_id = first_player
  where id = cid and created_by = auth.uid() and status = 'lobby';

  if not found then
    raise exception 'Only the host can start a campaign that is still in the lobby.';
  end if;

  insert into public.log_entries (campaign_id, turn_number, kind, content)
  values (cid, 1, 'system', 'The adventure begins!');
end;
$$;

revoke all on function public.new_campaign_code() from public, anon, authenticated;
revoke all on function public.is_member(uuid) from public, anon;
revoke all on function public.create_campaign(text, text) from public, anon;
revoke all on function public.join_campaign(text, text) from public, anon;
revoke all on function public.update_my_character(uuid, text, text) from public, anon;
revoke all on function public.start_campaign(uuid) from public, anon;
grant execute on function public.is_member(uuid) to authenticated;
grant execute on function public.create_campaign(text, text) to authenticated;
grant execute on function public.join_campaign(text, text) to authenticated;
grant execute on function public.update_my_character(uuid, text, text) to authenticated;
grant execute on function public.start_campaign(uuid) to authenticated;

-- Realtime -------------------------------------------------------------

alter publication supabase_realtime add table public.campaigns, public.players, public.log_entries;
