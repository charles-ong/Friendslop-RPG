-- Email notifications: each player can leave an address for "your turn" and
-- nudge emails. Addresses are private: nobody, not even the party, can read
-- someone else's. Safe to run more than once.

create table if not exists public.notify_emails (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  email      text not null check (length(email) <= 254 and email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  updated_at timestamptz not null default now()
);

alter table public.notify_emails enable row level security;
revoke all on public.notify_emails from anon, authenticated;

-- Blank removes the address.
create or replace function public.set_my_email(new_email text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'not signed in';
  end if;
  if coalesce(trim(new_email), '') = '' then
    delete from public.notify_emails where user_id = auth.uid();
    return;
  end if;
  if trim(new_email) !~* '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'That doesn''t look like an email address.';
  end if;
  insert into public.notify_emails (user_id, email)
  values (auth.uid(), lower(trim(new_email)))
  on conflict (user_id) do update set email = excluded.email, updated_at = now();
end;
$$;

create or replace function public.my_email()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select email from public.notify_emails where user_id = auth.uid();
$$;

revoke all on function public.set_my_email(text) from public, anon;
revoke all on function public.my_email() from public, anon;
grant execute on function public.set_my_email(text) to authenticated;
grant execute on function public.my_email() to authenticated;

-- From the Web Push update, in case that one hasn't been run yet.
alter table public.nudges add column if not exists pushed_at timestamptz;

notify pgrst, 'reload schema';
