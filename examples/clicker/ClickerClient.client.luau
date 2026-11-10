--!nonstrict
-- Clicker game UI: reads state from the server, buys upgrades, shows floating +N.
-- Lives in StarterGui.ClickerGui as the LocalScript "ClickerClient".

local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local TweenService = game:GetService("TweenService")

local player = Players.LocalPlayer
local gui = script.Parent
local panel = gui:WaitForChild("Panel")
local coinsLabel = panel:WaitForChild("Coins")
local statsLabel = panel:WaitForChild("Stats")
local clickButton = panel:WaitForChild("ClickUpgrade")
local autoButton = panel:WaitForChild("AutoUpgrade")
local popup = gui:WaitForChild("Popup")

local coinsChanged = ReplicatedStorage:WaitForChild("CoinsChanged")
local buyUpgrade = ReplicatedStorage:WaitForChild("BuyUpgrade")
local getStateRemote = ReplicatedStorage:WaitForChild("GetClickerState")
local requestClick = ReplicatedStorage:WaitForChild("RequestClick")

local gameFolder = workspace:WaitForChild("ClickerGame")
local detector = gameFolder:WaitForChild("Button"):WaitForChild("ClickDetector")

local clickArea = gui:WaitForChild("ClickArea")

local CLICK_COLOR = Color3.fromRGB(76, 145, 255)
local AUTO_COLOR = Color3.fromRGB(76, 200, 140)
local LOCKED_COLOR = Color3.fromRGB(58, 62, 74)

local state = {
	coins = 0,
	perClick = 1,
	autoRate = 0,
	clickCost = 10,
	autoCost = 25,
}

local popupTween: Tween? = nil

local function format(value: number): string
	if value >= 1e6 then
		return string.format("%.2fM", value / 1e6)
	elseif value >= 1e3 then
		return string.format("%.1fK", value / 1e3)
	end
	return tostring(math.floor(value))
end

local function refresh()
	coinsLabel.Text = format(state.coins)
	statsLabel.Text = string.format(
		"+%s per click   ·   %s per second",
		format(state.perClick),
		format(state.autoRate)
	)
	clickButton.Text = string.format("Better Click   →   %s", format(state.clickCost))
	autoButton.Text = string.format("Auto Clicker   →   %s", format(state.autoCost))

	local canClick = state.coins >= state.clickCost
	local canAuto = state.coins >= state.autoCost
	clickButton.BackgroundColor3 = canClick and CLICK_COLOR or LOCKED_COLOR
	autoButton.BackgroundColor3 = canAuto and AUTO_COLOR or LOCKED_COLOR
end

local function showPopup(amount: string)
	popup.Text = "+" .. amount
	popup.TextTransparency = 0
	popup.Position = UDim2.new(0.5, -100, 0.62, 0)

	if popupTween then
		popupTween:Cancel()
	end

	popupTween = TweenService:Create(
		popup,
		TweenInfo.new(0.65, Enum.EasingStyle.Quad, Enum.EasingDirection.Out),
		{ Position = UDim2.new(0.5, -100, 0.44, 0), TextTransparency = 1 }
	)
	popupTween:Play()
end

coinsChanged.OnClientEvent:Connect(function(snapshot)
	state = snapshot
	refresh()
end)

clickButton.MouseButton1Click:Connect(function()
	buyUpgrade:FireServer("click")
end)

autoButton.MouseButton1Click:Connect(function()
	buyUpgrade:FireServer("auto")
end)

detector.MouseClick:Connect(function(who)
	if who == player then
		showPopup(format(state.perClick))
	end
end)

clickArea.MouseButton1Click:Connect(function()
	requestClick:FireServer()
	showPopup(format(state.perClick))
end)

local initial = nil
for _ = 1, 20 do
	local ok, snapshot = pcall(function()
		return getStateRemote:InvokeServer()
	end)
	if ok and type(snapshot) == "table" then
		initial = snapshot
		break
	end
	task.wait(0.25)
end

if initial then
	state = initial
end
refresh()
