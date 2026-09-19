# screepsmod-client-new (single-shard-room-channel fork)

Screeps private-server mod that serves a browser client at `/client` on the same server it runs on. The client connects to its own origin, so no separate hosting or CORS setup is required.

This is a fork of [`bastianh/screeps-client`](https://github.com/bastianh/screeps-client)'s `screeps-mod-client` + `screeps-connectivity` packages, cut from the `screeps-client@0.24.3` tag. Upstream's `RoomStore` subscribes only to the shard-prefixed pub/sub channel (`room:<shard>/<room>`) whenever the server reports a shard name via `/api/version`. Some private-server engines (screeps-launcher included) report a shard name but never prefix their channels with it — a classic single-shard convention that predates official multi-shard servers — so room contents (creeps, structures, the controller) never render; only terrain shows. This fork also subscribes to the unprefixed `room:<room>` channel whenever a shard is given, so it works against both conventions. See [screeps-connectivity's `RoomStore.ts`](https://github.com/pieterbrandsen/screeps-client/blob/fix/single-shard-room-channel/screeps-connectivity/src/stores/RoomStore.ts) for the fix and its tests.

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

The mod resolves the client bundle from its [`screeps-client`](../screeps-client) dependency at runtime — no separate build step is needed. The bundle is built with `base=/client/`, so the mount path must match.
