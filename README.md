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
   , [`supabase/migrations/20261007030000_pause_nudge.sql`](supabase/migrations/20261007030000_pause_nudge.sql)
   , [`supabase/migrations/20261007040000_web_push.sql`](supabase/migrations/20261007040000_web_push.sql)
   and [`supabase/migrations/20261007050000_email_notify.sql`](supabase/migrations/20261007050000_email_notify.sql).
4. **Groq key:** Edge Functions → Secrets → add `GROQ_API_KEY`. Optionally add `GROQ_MODEL`
   (tried first; otherwise `openai/gpt-oss-120b`, then other Groq models your key can use).
5. **Email notifications (optional):** sign up at [brevo.com](https://www.brevo.com) (free, 300 emails a
   day), verify the address you'll send from under Senders, and create an API key under SMTP & API.
   Add Edge Function secrets `BREVO_API_KEY` (the key) and `BREVO_SENDER` (that address).
   Optionally set `SITE_URL` if the site isn't at `https://charles-ong.github.io/Friendslop-RPG/`.
6. **Gamemaster function:** create a personal access token at
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
  logged and shows as a toast for the target. The tab title says "(Your turn!)" too.
- Notifications: "Turn on notifications" subscribes the browser to Web Push (`public/sw.js`) and
  saves the subscription with `save_push_subscription`. The `gamemaster` function pushes
  "Your turn" whenever the turn passes to someone, and pushes each nudge to its target, so they
  arrive with the site closed. Its VAPID keys are generated on first use and stored in the private
  `app_secrets` table; there's nothing to configure. On iPhone, notifications need the site added
  to the home screen first (Share → Add to Home Screen), then turned on from the installed app.
- Email: players can leave an address in the Notifications card (stored privately, via
  `set_my_email`). Turn and nudge alerts are emailed through Brevo when the player hasn't been on the
  site for 2 minutes. "Send me a test" sends a push and an email and shows what happened to each.
- Invite links look like `…/#/join/ABC234`. Hash routing keeps deep links working on GitHub Pages.
