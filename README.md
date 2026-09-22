# screepsmod-client-new (single-shard-room-channel fork)

Screeps private-server mod that serves a browser client at `/client` on the same server it runs on. The client connects to its own origin, so no separate hosting or CORS setup is required.

This is a fork of [`bastianh/screeps-client`](https://github.com/bastianh/screeps-client)'s `screeps-mod-client` + `screeps-connectivity` packages, cut from the `screeps-client@0.24.3` tag. Both fixes on this branch share one root cause: some private-server engines (screeps-launcher included) report a shard name via `/api/version` while still speaking the classic single-shard conventions that predate official multi-shard servers, and upstream trusts that shard name unconditionally.

- **Room contents never rendered — only terrain.** Upstream's `RoomStore` subscribes only to the shard-prefixed pub/sub channel (`room:<shard>/<room>`) once a shard is reported. This fork also subscribes to the unprefixed `room:<room>` channel whenever a shard is given, so it works against both conventions. See [`RoomStore.ts`](https://github.com/pieterbrandsen/screeps-client/blob/fix/single-shard-room-channel/screeps-connectivity/src/stores/RoomStore.ts).
- **History playback never worked.** Upstream's `roomHistory` requests the shard-prefixed path `/room-history/<shard>/<room>/<time>.json` once a shard is reported — the official multi-shard convention. `screepsmod-history` only understands the classic query-string form (`/room-history?room=&time=`), so that path 500s. This fork falls back to the query-string form whenever the shard-prefixed request fails with anything other than a genuine 404. See [`game.ts`](https://github.com/pieterbrandsen/screeps-client/blob/fix/single-shard-room-channel/screeps-connectivity/src/http/endpoints/game.ts).

Unlike upstream's `screeps-mod-client`, this fork vendors the built client (`dist/embedded`) directly in the package rather than resolving it from a separate `screeps-client` npm dependency — there's no monorepo/workspace context to resolve it in once this is installed standalone via `extraPackages`.

## Install

Add the package to your server's `mods.json`:

```json
{
  "mods": [
    "node_modules/screepsmod-client-new"
  ]
}
```

## Configuration

Two layers, in order of precedence:

1. Environment variables (highest)
2. `modConfig.client` in `mods.json`
3. Defaults

| Setting | ENV | `modConfig.client.*` | Default |
| --- | --- | --- | --- |
| Mount path | `SCREEPS_MOD_CLIENT_MOUNT_PATH` | `mountPath` | `/client` |
| Redirect `/` → mount path | `SCREEPS_MOD_CLIENT_ROOT_REDIRECT` | `rootRedirect` | `true` |
| Page title | `SCREEPS_CLIENT_TITLE` | `title` | `Alknost.space` |
| Signup club password (required on register when set) | `SCREEPS_CLUB_PASSWORD` | — | unset (open registration) |
| Disable rate limiting | `SCREEPS_RATE_LIMIT_DISABLED=1` | — | off |
| Register attempts per 15 min per IP | `SCREEPS_RATE_LIMIT_REGISTER_MAX` | — | `5` |
| Signin attempts per 15 min per IP | `SCREEPS_RATE_LIMIT_SIGNIN_MAX` | — | `20` |
| Username/email checks per min per IP | `SCREEPS_RATE_LIMIT_CHECK_MAX` | — | `60` |

## Fork additions

On top of the single-shard fixes, this fork adds:

- **Club-password gate** on `POST /api/register/submit` (constant-time compare; the vendored client build has the matching "Club Password" field on the signup form).
- **Security headers** on every response (CSP with a per-request nonce, `nosniff`, frame denial, referrer/permissions policies, COOP/CORP, `noindex`, HSTS when served over HTTPS) and no `X-Powered-By`.
- **Rate limiting** for registration, signin, and username/email availability checks.
- **Client-IP handling for a publicly reachable origin:** `CF-Connecting-IP`/`X-Forwarded-For` are only trusted when the TCP peer is loopback, a private/link-local address (Docker gateway, host reverse proxy, tunnel), or a Cloudflare edge range, so direct clients cannot spoof their way around rate limits.

### Docker example

```sh
docker run -e SCREEPS_MOD_CLIENT_MOUNT_PATH=/play \
           -e SCREEPS_MOD_CLIENT_ROOT_REDIRECT=false \
           -e SCREEPS_CLUB_PASSWORD=... \
           screeps/private-server
```

## How it works

The mod serves the client bundle vendored in-tree at `dist/embedded` (built with `base=/client/`, so the mount path must match) rather than resolving it from a separate `screeps-client` npm dependency at runtime — there's no monorepo/workspace context to resolve it in once this is installed standalone via `extraPackages`. Rebuilding it means rebuilding `screeps-connectivity` and `screeps-client` on the [source branch](https://github.com/pieterbrandsen/screeps-client/tree/fix/single-shard-room-channel) and copying `screeps-client/dist/embedded` back into this repo's `dist/`.
