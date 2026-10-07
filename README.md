# 🎲 Friendslop RPG

An asynchronous multiplayer text RPG for 4 to 10 friends, narrated by an AI Gamemaster.
Players take turns on one shared timeline; when it's someone's turn and they're offline,
the world pauses and everyone else can read the log and give them a nudge.

- **Frontend:** Svelte 5 + TypeScript + Vite, deployed to GitHub Pages
- **Backend:** Supabase (Postgres, anonymous auth, Realtime)
- **Gamemaster:** Groq, called from a Supabase Edge Function so the API key stays secret

## Run locally

```sh
npm install
npm run dev
```

## One-time Supabase setup

1. **Enable anonymous sign-ins:** Authentication → Sign In / Providers → Anonymous sign-ins → on.
2. **Create the schema:** open the SQL Editor, paste
   [`supabase/migrations/20261007000000_init.sql`](supabase/migrations/20261007000000_init.sql),
   and run it.

The project URL and publishable key live in [`src/lib/config.ts`](src/lib/config.ts).
They're safe to publish; row level security keeps each party's data private.
**Never** put the Groq key in this repo. It goes in Supabase as an Edge Function secret.

## Deploy

Settings → Pages → Build and deployment → Source: **GitHub Actions**.
Every push to `main` then builds and deploys the site.

## How it fits together

- Everyone signs in anonymously, so `auth.uid()` identifies a browser.
- Clients only **read** tables directly. Every write goes through a database function
  (`create_campaign`, `join_campaign`, `start_campaign`, `update_my_character`) or, for
  narration, the Gamemaster edge function.
- Invite links look like `…/#/join/ABC234`. Hash routing keeps deep links working on GitHub Pages.
