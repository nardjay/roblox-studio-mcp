# Clicker game

A small but complete clicker built entirely through the MCP bridge:

- **Click income** — click the neon wall in 3D or the big `CLICK` HUD button.
- **Two upgrade tracks** — `Better Click` (+1 per click, cost ×1.6) and
  `Auto Clicker` (+1 coin/second, cost ×1.8).
- **Server-authoritative state** — the client never decides how many coins it has;
  it only renders snapshots pushed from the server.
- **Idle income** — one server tick per second for players who own auto clickers.
- **Feedback** — floating `+N`, affordable upgrades light up green/blue.

## Where it lands in the place

| Instance | Purpose |
|---|---|
| `Workspace.ClickerGame` | Base, neon `Button` + `ClickDetector`, lamps, `PlayerSpawn` |
| `ServerScriptService.ClickerLogic` | Pure math (ModuleScript, unit tested) |
| `ServerScriptService.ClickerServer` | Wiring: players, remotes, idle loop |
| `ReplicatedStorage.CoinsChanged` | Server → client state snapshots |
| `ReplicatedStorage.BuyUpgrade` | Client → server upgrade request |
| `ReplicatedStorage.RequestClick` | Client → server HUD click |
| `ReplicatedStorage.GetClickerState` | Initial state fetch |
| `StarterGui.ClickerGui` | Panel, coins, stats, upgrade buttons, `CLICK`, popup |

## Build / rebuild

```powershell
node scripts/build-clicker.mjs      # rebuilds all of the above from these files
```

The place's original spawn is disabled (not deleted) so players spawn facing the game.

## Tuning

Edit `ClickerLogic.luau` — `CLICK_BASE_COST`, `CLICK_GROWTH`, `AUTO_BASE_COST`,
`AUTO_GROWTH` — then rebuild. `npm test` covers the math:

- 1 coin per click at level 0, 10 clicks afford the first upgrade,
- upgrade deducts cost, raises per-click to 2, next cost 16,
- purchase is refused when unaffordable,
- auto clicker costs 25, raises idle income to 1/s, next cost 45.

## Ideas to extend

- Persistence with `DataStoreService` (needs a published place).
- Rebirth/prestige tier that resets upgrades for a permanent multiplier.
- Click combo meter, particle burst, or a `ClickDetector` on a moving target.
