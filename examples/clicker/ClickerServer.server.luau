--!nonstrict
-- Clicker game server: per-player state, click income, upgrades, idle income.
-- Lives in ServerScriptService.ClickerServer; the math lives in ClickerLogic.

local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")

local Logic = require(script.Parent:WaitForChild("ClickerLogic"))

local coinsChanged = ReplicatedStorage:WaitForChild("CoinsChanged")
local buyUpgrade = ReplicatedStorage:WaitForChild("BuyUpgrade")
local getStateRemote = ReplicatedStorage:WaitForChild("GetClickerState")
local requestClick = ReplicatedStorage:WaitForChild("RequestClick")

local gameFolder = workspace:WaitForChild("ClickerGame")
local detector = gameFolder:WaitForChild("Button"):WaitForChild("ClickDetector")

local states: { [Player]: any } = {}
local lastClickAt: { [Player]: number } = {}

-- Clicks can arrive twice for one physical input (HUD button plus the 3D
-- ClickDetector behind it), so drop anything inside the same 60ms window.
local MIN_CLICK_INTERVAL = 0.06

local function getState(player: Player)
	local state = states[player]
	if not state then
		state = Logic.newState()
		states[player] = state
	end
	return state
end

local function push(player: Player)
	local state = states[player]
	if state then
		coinsChanged:FireClient(player, Logic.snapshot(state))
	end
end

local function countClick(player: Player)
	local now = os.clock()
	local last = lastClickAt[player]
	if last and now - last < MIN_CLICK_INTERVAL then
		return
	end
	lastClickAt[player] = now

	local state = getState(player)
	Logic.click(state)
	push(player)
end

Players.PlayerAdded:Connect(function(player)
	states[player] = Logic.newState()
	task.defer(push, player)
end)

Players.PlayerRemoving:Connect(function(player)
	states[player] = nil
	lastClickAt[player] = nil
end)

getStateRemote.OnServerInvoke = function(player: Player)
	return Logic.snapshot(getState(player))
end

detector.MouseClick:Connect(function(player: Player)
	countClick(player)
end)

-- The HUD button calls the same handler, so clicking the wall or the screen
-- button is identical to the server.
requestClick.OnServerEvent:Connect(function(player: Player)
	countClick(player)
end)

buyUpgrade.OnServerEvent:Connect(function(player: Player, kind: any)
	local state = getState(player)
	if Logic.buy(state, kind) then
		push(player)
	end
end)

-- Idle income: one tick per second, only for players who own auto clickers.
task.spawn(function()
	while true do
		task.wait(1)
		for player, state in pairs(states) do
			if player.Parent ~= nil and state.autoRate > 0 then
				Logic.tick(state)
				push(player)
			end
		end
	end
end)

print("[ClickerGame] server ready")
