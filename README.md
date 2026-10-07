# vibe/vibe Builder Access Worker

Private, stateless Cloudflare Worker that checks Wick verification and grants the existing Discord `Testnet Builder` role. It is separate from and must never replace or modify `vibe-vibe-discord-relay`.

## Architecture

- Worker name: `vibe-vibe-builder-access`
- Source entry: `src/worker.js`
- Cloudflare configuration: `wrangler.toml`
- Discord Gateway: not used
- Database: not used
- Public commands or interactions: not used

The website owns Discord OAuth, wallet links, retries, user-facing rate limits, assignment history, unlinking, and deletion. The Worker receives only a request UUID and Discord user ID.

## Cloudflare configuration

Non-secret variables:

```text
DISCORD_APPLICATION_ID=1557347396323770449
DISCORD_GUILD_ID=1541735368670314556
DISCORD_BUILDER_ROLE_ID=1544668532917403758
DISCORD_VERIFIED_ROLE_ID=1544668604568440842
```

Encrypted secrets:

```text
DISCORD_BOT_TOKEN=<new Builder Access bot token>
WEBSITE_SERVICE_HMAC_SECRET=<new independent 32-byte-or-longer random secret>
```

Never reuse the attribution bot token or `RELAY_SECRET`. Never place either new secret in `wrangler.toml`, source control, Discord, screenshots, tickets, or chat.

The ignored local `.env` currently holds the Builder bot token for transfer into Cloudflare's encrypted secret field. It is not read by the Worker and must remain uncommitted.

## Local verification

The code has no production dependencies. Run:

```powershell
npm test
npm run check
```

The current workstation runs Node 16, so the test command enables Node's experimental Fetch API. Cloudflare provides Fetch and Web Crypto natively.

## Endpoints

- `GET /healthz`: process health; does not call Discord.
- `GET /readyz`: validates the real bot identity, guild, role IDs, Manage Roles permission, absence of Administrator, and role hierarchy.
- `POST /internal/v1/discord/builder-role/assign`: HMAC-authenticated assignment.

Assignment request:

```json
{
  "requestId": "4bd69619-70c2-4c82-a917-b6b79fa7f401",
  "discordUserId": "123456789012345678"
}
```

Signature input:

```text
<X-VV-Timestamp>.<exact raw HTTP request body bytes>
```

The signature is lowercase hexadecimal HMAC-SHA256. The Worker accepts timestamps no more than five minutes old or 30 seconds in the future.

## Safe deployment order

1. Confirm the `Testnet Builder` and `Verified` role IDs.
2. Confirm those IDs in `wrangler.toml`; do not substitute a future mainnet role without a separately approved deployment change.
3. Create the separate `vibe-vibe-builder-access` Worker.
4. Add its two encrypted secrets and deploy this source.
5. Confirm `/healthz` is HTTP 200; `/readyz` should remain HTTP 503 until the bot is installed.
6. Install the bot with only Manage Roles and restore Wick's Bot Addition Filter.
7. Position the bot role immediately above `Testnet Builder` and below every staff/moderation role.
8. Require `/readyz` to return HTTP 200.
9. Run the spare-account acceptance tests.
10. Give Boss the new Worker URL and HMAC secret through approved secret channels. Never give Boss the bot token.

## Isolation from attribution

The existing attribution Worker remains:

```text
vibe-vibe-discord-relay
```

This Builder Worker has a different name, source directory, URL, Discord application, bot token, HMAC secret, endpoints, and permissions. Deployment must target `vibe-vibe-builder-access`; stop if Cloudflare shows the attribution Worker as the deployment target.
