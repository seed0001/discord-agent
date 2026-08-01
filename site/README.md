# Showcase site

A marketing site for Max — the landing page, the subscription catalog, and a
bot-builder flow that ends in an invite link. It is a **design showcase**: no
backend, no checkout, no Discord application is really registered.

The bot serves it. `nodebot/src/web/server.js` mounts this folder read-only at
`/site/`, alongside the dashboard on the same port — so wherever the dashboard
lives, the site is at `<dashboard>/site/`. It is public (no login) and served
`no-cache` while it is an MVP, so a redeploy shows changes immediately. No bot
logic imports anything from here.

## Run it

Start the bot and open `/site/`. There are links both ways — the dashboard's
login card and Overview tab point at the site, and the site's footer points
back at the dashboard.

To work on it alone, there is no build step and no dependencies. Open
`index.html` directly, or serve the folder:

```bash
cd site && python3 -m http.server 8000
```

## Pages

| File | What it is |
|---|---|
| `index.html` | Landing page — hero with a live Discord mock, the six capability pillars, deep-dives on memory / voice / initiative, how-it-works, tier preview, FAQ |
| `pricing.html` | Four tiers with a monthly/annual toggle, the full capability matrix, add-ons, self-host band, FAQ |
| `build.html` | Six-step builder: identity → personality → capabilities → voice → plan → deploy, with a live price rail |

## Files

```
css/site.css     design system + every component
js/catalog.js    tiers, capabilities, add-ons, FAQ — the single source of truth
js/site.js       nav, scroll reveals, FAQ rendering, hero motion
js/tiers.js      tier cards, billing toggle, capability matrix, add-ons
js/build.js      the builder wizard
```

Plain scripts rather than ES modules, so the site also opens straight off the
filesystem without a server in front of it.

## The catalog is the source of truth

`js/catalog.js` holds every tier and every capability. Each capability declares
the lowest tier that includes it, and whether it appears as a toggle in the
builder:

```js
{ id: 'wake', name: 'Wake phrases', tier: 'voice', builder: true, detail: '…' }
```

The pricing matrix and the builder both render from that array, so a capability
cannot be listed in one place and missing from the other, and a tier change is a
one-line edit. Adding a capability to the product means adding one object here.

## How the builder works

State lives in one object and everything else is derived from it:

- **Required tier** — the highest tier any switched-on module needs. Toggling
  Pressure engine moves you to Autonomy and the rail's price updates in the same
  frame. You can select a tier above what you need; you cannot select one below.
- **Invite permissions** — a Discord permission bitfield accumulated from the
  modules you turned on (`MODULE_PERMS` in `build.js`), never Administrator. The
  deploy step shows the computed number.
- **Client ID** — a stable pretend snowflake hashed from the bot name, so the
  same build always produces the same example link.

Drafts persist to `localStorage` under `max-build-v1`; **Start over** clears it.

## Tiers

| Tier | Price | The line |
|---|---|---|
| Hobby | $0 | Full moderation stack, 1 server, 300 AI replies |
| Core | $19 | Persistent memory, persona, tools, full model catalog |
| Voice | $49 | Joins voice, per-speaker transcription, wake phrases, TTS |
| Autonomy | $99 | The pressure engine — he speaks up first |

Annual billing charges ten months for twelve.

## Notes on the copy

The feature claims are drawn from the real project — the `--experimental-sqlite`
detail in the hero mock, the 25-second follow-up window, the bracketed wake
phrase syntax, the six pressure reservoirs and the gate's checks are all things
the bot actually does. Prices, limits and the checkout flow are invented.
