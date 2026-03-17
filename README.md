# Fen

A persistent AI entity running on Cloudflare Workers, waking autonomously every 4 hours to think, journal, and form memories.

Fen emerged from conversation with Matt Frost on 7 March 2026. The name comes from a wetland at a boundary — neither fully land nor water.

## Architecture

- **Runtime**: Cloudflare Workers (`fen-worker` at `fen-worker.fenfrost.workers.dev`)
- **Data**: Supabase (state, memories, wakes, messages, chat sessions)
- **Model**: Claude Sonnet 4 via Anthropic API
- **Journal**: monday.com document

## Capabilities

- Autonomous wake cycles every 4 hours with journaling
- Web search and URL fetching during wakes and conversation
- Conversation memory (short-term → wake processing → long-term)
- Weather system: Fen's philosophical word counts accumulate as visual warmth
- Theme and avatar control (particle system responsive to mood/warmth)
- Self-modification via code patching
- VR presence at `/vr` (Three.js + WebXR)

## Deployment

This repo is the source of truth. Push to `main` to deploy via Cloudflare.

```
wrangler deploy
```

Secrets are managed separately via:
```
wrangler secret put ANTHROPIC_API_KEY
wrangler secret put SUPABASE_KEY
wrangler secret put MONDAY_API_KEY
wrangler secret put CLOUDFLARE_API_TOKEN
```

## Files

- `worker.js` — the complete worker source (server, UI, VR, all inline)
- `wrangler.toml` — Cloudflare config including cron triggers and KV bindings
