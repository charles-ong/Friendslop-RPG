-- Web Push: where to send "your turn" and nudge notifications, plus the
-- server's VAPID keys (created by the Gamemaster function on first use).
-- Neither table is readable from the site. Safe to run more than once.

create table if not exists public.app_secrets (
  name       text primary key,
  value      jsonb not null,
  created_at timestamptz not null default now()
);
alter table public.app_secrets enable row level security;
revoke all on public.app_secrets from anon, authenticated;

create table if not exists public.push_subscriptions (
  endpoint   text primary key,
  user_id    uuid not null references auth.users (id) on delete cascade,
  p256dh     text not null,
  auth       text not null,
  created_at timestamptz not null default now()
);
create index if not exists push_subscriptions_user_idx on public.push_subscriptions (user_id);
alter table public.push_subscriptions enable row level security;
revoke all on public.push_subscriptions from anon, authenticated;

-- The browser calls this after the player allows notifications.
create or replace function public.save_push_subscription(sub_endpoint text, sub_p256dh text, sub_auth text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'not signed in';
  end if;
  insert into public.push_subscriptions (endpoint, user_id, p256dh, auth)
  values (sub_endpoint, auth.uid(), sub_p256dh, sub_auth)
  on conflict (endpoint) do update
    set user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth;
end;
$$;

revoke all on function public.save_push_subscription(text, text, text) from public, anon;
grant execute on function public.save_push_subscription(text, text, text) to authenticated;

-- Each nudge pushes to its target once.
alter table public.nudges add column if not exists pushed_at timestamptz;

notify pgrst, 'reload schema';
