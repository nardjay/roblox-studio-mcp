import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

let Lua = null;
try {
  ({ Lua } = await import('@luau-rs/luau'));
} catch {
  Lua = null;
}

const LOGIC = fileURLToPath(new URL('../examples/clicker/ClickerLogic.luau', import.meta.url));

test(
  'clicker logic: clicks, costs, upgrades and idle income',
  { skip: Lua ? false : 'devDependency @luau-rs/luau is not installed' },
  async () => {
    const lua = await Lua.create();
    const source = await readFile(LOGIC, 'utf8');

    const harness = `
local Logic = (function()
${source}
end)()

local state = Logic.newState()
assert(state.coins == 0, "fresh state starts at 0 coins")
assert(state.perClick == 1, "starts at 1 per click")
assert(Logic.clickCost(state) == 10, "first click upgrade costs 10")
assert(Logic.autoCost(state) == 25, "first auto clicker costs 25")

Logic.click(state)
assert(state.coins == 1, "one click earns perClick")
for _ = 1, 9 do
	Logic.click(state)
end
assert(state.coins == 10, "ten clicks earn ten coins")

assert(Logic.buy(state, "click") == true, "affordable upgrade is bought")
assert(state.coins == 0, "cost is deducted")
assert(state.perClick == 2, "per click increases")
assert(Logic.clickCost(state) == 16, "click cost grows by 1.6x")

assert(Logic.buy(state, "click") == false, "unaffordable upgrade is refused")
assert(state.clickLevel == 1, "refused upgrade does not change level")

state.coins = 100
assert(Logic.buy(state, "auto") == true, "auto clicker is bought")
assert(state.autoRate == 1, "auto rate increases")
assert(state.coins == 75, "auto cost deducted")
assert(Logic.autoCost(state) == 45, "auto cost grows by 1.8x")

Logic.tick(state)
assert(state.coins == 76, "idle tick adds autoRate")

local snapshot = Logic.snapshot(state)
assert(snapshot.coins == 76 and snapshot.perClick == 2 and snapshot.autoRate == 1)
assert(snapshot.clickCost == 16 and snapshot.autoCost == 45, "snapshot carries next costs")

assert(Logic.buy(state, "nonsense") == false, "unknown upgrade kind is ignored")
return "ok"
`;

    const result = lua.execute(harness);
    assert.equal(result[0], 'ok');
  },
);
