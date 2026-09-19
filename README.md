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
    "node_modules/screeps-mod-client"
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

### Docker example

```sh
docker run -e SCREEPS_MOD_CLIENT_MOUNT_PATH=/play \
           -e SCREEPS_MOD_CLIENT_ROOT_REDIRECT=false \
           screeps/private-server
```

## How it works

The mod serves the client bundle vendored in-tree at `dist/embedded` (built with `base=/client/`, so the mount path must match) rather than resolving it from a separate `screeps-client` npm dependency at runtime — there's no monorepo/workspace context to resolve it in once this is installed standalone via `extraPackages`. Rebuilding it means rebuilding `screeps-connectivity` and `screeps-client` on the [source branch](https://github.com/pieterbrandsen/screeps-client/tree/fix/single-shard-room-channel) and copying `screeps-client/dist/embedded` back into this repo's `dist/`.
