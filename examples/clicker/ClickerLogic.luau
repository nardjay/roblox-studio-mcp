--!nonstrict
-- Pure clicker math and state transitions.
-- No Roblox APIs, so this module is unit tested outside Studio
-- (see test/clicker-logic.test.js). The server script is just wiring.

local Logic = {}

Logic.CLICK_BASE_COST = 10
Logic.CLICK_GROWTH = 1.6
Logic.AUTO_BASE_COST = 25
Logic.AUTO_GROWTH = 1.8

function Logic.newState()
	return {
		coins = 0,
		perClick = 1,
		autoRate = 0,
		clickLevel = 0,
		autoLevel = 0,
	}
end

function Logic.clickCost(state): number
	return math.floor(Logic.CLICK_BASE_COST * Logic.CLICK_GROWTH ^ state.clickLevel)
end

function Logic.autoCost(state): number
	return math.floor(Logic.AUTO_BASE_COST * Logic.AUTO_GROWTH ^ state.autoLevel)
end

function Logic.snapshot(state)
	return {
		coins = state.coins,
		perClick = state.perClick,
		autoRate = state.autoRate,
		clickCost = Logic.clickCost(state),
		autoCost = Logic.autoCost(state),
	}
end

function Logic.click(state): number
	state.coins += state.perClick
	return state.coins
end

function Logic.tick(state): number
	if state.autoRate > 0 then
		state.coins += state.autoRate
	end
	return state.coins
end

function Logic.buy(state, kind: string): boolean
	if kind == "click" then
		local cost = Logic.clickCost(state)
		if state.coins < cost then
			return false
		end
		state.coins -= cost
		state.clickLevel += 1
		state.perClick += 1
		return true
	elseif kind == "auto" then
		local cost = Logic.autoCost(state)
		if state.coins < cost then
			return false
		end
		state.coins -= cost
		state.autoLevel += 1
		state.autoRate += 1
		return true
	end
	return false
end

return Logic
