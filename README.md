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
3. **Turn loop schema:** run
   [`supabase/migrations/20261007010000_turn_loop.sql`](supabase/migrations/20261007010000_turn_loop.sql)
   the same way, then
   [`supabase/migrations/20261007020000_setting.sql`](supabase/migrations/20261007020000_setting.sql)
   and [`supabase/migrations/20261007030000_pause_nudge.sql`](supabase/migrations/20261007030000_pause_nudge.sql).
4. **Groq key:** Edge Functions → Secrets → add `GROQ_API_KEY`. Optionally add `GROQ_MODEL`
   (tried first; otherwise `openai/gpt-oss-120b`, then other Groq models your key can use).
5. **Gamemaster function:** create a personal access token at
   [supabase.com/dashboard/account/tokens](https://supabase.com/dashboard/account/tokens) and save it
   as a GitHub repository secret named `SUPABASE_ACCESS_TOKEN`. The
   *Deploy Supabase functions* workflow then deploys `supabase/functions/` on every change
   (or run it by hand from the Actions tab).

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
  turns, the Gamemaster edge function.
- Starting: in the lobby the host asks the Gamemaster for three setting ideas (or writes their own);
  picking one has the Gamemaster write an opening scene, and `begin_campaign` saves it and gives
  seat 1 the first turn.
- A turn: the current player writes an action and rolls a d20 in the browser. The `gamemaster`
  function checks it's their turn (`begin_turn`), sends the party, recent log, action and roll
  to Groq, then saves the narration, applies any HP changes and passes the turn to the next seat
  (`finish_turn`). If Groq fails, `abort_turn` undoes the action so the player can retry.
- Pausing: each open campaign page joins a Supabase Realtime presence channel and calls
  `mark_seen` every minute. When the current player isn't present, everyone else sees
  "The world is paused" with when they were last seen. Nothing happens to the party until that
  player acts, so nobody is left in danger.
- Nudging: waiting players can `nudge` the current player (once per 5 minutes each). The nudge is
  logged, shows as a toast for the target, and pops a browser notification if they turned
  notifications on and the tab is in the background. The tab title says "(Your turn!)" too.
- Invite links look like `…/#/join/ABC234`. Hash routing keeps deep links working on GitHub Pages.
