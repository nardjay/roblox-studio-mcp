--!nonstrict
-- RobloxMCP Studio plugin entry point.
-- Shows a small control panel, long-polls the local MCP bridge and executes
-- read/write operations against the open place.

local ChangeHistoryService = game:GetService("ChangeHistoryService")
local RunService = game:GetService("RunService")
local Selection = game:GetService("Selection")

local Api = require(script.Api)
local Codec = require(script.Codec)
local Ops = require(script.Ops)
local Paths = require(script.Paths)

local PROTOCOL = 1
local POLL_TIMEOUT_SECONDS = 15

local state = {
	running = false,
	connected = false,
	served = 0,
	port = 44755,
	token = "",
	lastError = "",
}

local currentApi = nil
local pendingLogs = {}

-- ------------------------------------------------------------------ settings

local function loadSetting(key: string, default: any): any
	local ok, value = pcall(function()
		return plugin:GetSetting(key)
	end)
	if ok and value ~= nil then
		return value
	end
	return default
end

local function saveSetting(key: string, value: any)
	pcall(function()
		plugin:SetSetting(key, value)
	end)
end

-- ----------------------------------------------------------------------- ui

local function create(className: string, properties: any, children: { Instance }?): any
	local instance = Instance.new(className)
	for key, value in pairs(properties or {}) do
		instance[key] = value
	end
	for _, child in ipairs(children or {}) do
		child.Parent = instance
	end
	return instance
end

local palette = {
	background = Color3.fromRGB(38, 39, 44),
	panel = Color3.fromRGB(48, 49, 56),
	text = Color3.fromRGB(235, 236, 240),
	muted = Color3.fromRGB(160, 163, 172),
	accent = Color3.fromRGB(72, 132, 232),
	ok = Color3.fromRGB(88, 196, 126),
	bad = Color3.fromRGB(226, 106, 106),
}

local toolbar = plugin:CreateToolbar("RobloxMCP")
local toolbarButton = toolbar:CreateButton("RobloxMCP", "Connect Studio to the RobloxMCP server", "")
toolbarButton.ClickableWhenViewportHidden = true

local widgetInfo = DockWidgetPluginGuiInfo.new(Enum.InitialDockState.Right, false, false, 380, 460, 320, 320)
local widget = plugin:CreateDockWidgetPluginGui("RobloxMCP", widgetInfo)
widget.Title = "RobloxMCP"
widget.Name = "RobloxMCP"

local ui = {}

local root = create("Frame", {
	Name = "Root",
	Size = UDim2.fromScale(1, 1),
	BackgroundColor3 = palette.background,
	BorderSizePixel = 0,
}, { create("UIPadding", { PaddingTop = UDim.new(0, 10), PaddingBottom = UDim.new(0, 10), PaddingLeft = UDim.new(0, 10), PaddingRight = UDim.new(0, 10) }) })
root.Parent = widget

local top = create("Frame", {
	Name = "Top",
	Size = UDim2.new(1, 0, 0, 236),
	BackgroundTransparency = 1,
	BorderSizePixel = 0,
}, {
	create("UIListLayout", {
		Padding = UDim.new(0, 6),
		SortOrder = Enum.SortOrder.LayoutOrder,
	}),
})
top.Parent = root

local header = create("Frame", {
	Name = "Header",
	Size = UDim2.new(1, 0, 0, 24),
	BackgroundTransparency = 1,
	LayoutOrder = 1,
})
header.Parent = top

ui.dot = create("Frame", {
	Name = "Dot",
	Size = UDim2.fromOffset(10, 10),
	Position = UDim2.new(0, 0, 0.5, -5),
	BackgroundColor3 = palette.bad,
	BorderSizePixel = 0,
}, { create("UICorner", { CornerRadius = UDim.new(1, 0) }) })
ui.dot.Parent = header

create("TextLabel", {
	Name = "Title",
	Position = UDim2.new(0, 18, 0, 0),
	Size = UDim2.new(1, -60, 1, 0),
	BackgroundTransparency = 1,
	Font = Enum.Font.GothamBold,
	Text = "RobloxMCP",
	TextColor3 = palette.text,
	TextSize = 16,
	TextXAlignment = Enum.TextXAlignment.Left,
}).Parent = header

ui.version = create("TextLabel", {
	Name = "Version",
	Position = UDim2.new(1, -70, 0, 0),
	Size = UDim2.new(0, 70, 1, 0),
	BackgroundTransparency = 1,
	Font = Enum.Font.Gotham,
	Text = "v" .. Ops.PLUGIN_VERSION,
	TextColor3 = palette.muted,
	TextSize = 11,
	TextXAlignment = Enum.TextXAlignment.Right,
})
ui.version.Parent = header

ui.status = create("TextLabel", {
	Name = "Status",
	LayoutOrder = 2,
	Size = UDim2.new(1, 0, 0, 0),
	AutomaticSize = Enum.AutomaticSize.Y,
	BackgroundTransparency = 1,
	Font = Enum.Font.Gotham,
	Text = "Idle. Press Connect to attach to the MCP server.",
	TextColor3 = palette.muted,
	TextSize = 12,
	TextWrapped = true,
	TextXAlignment = Enum.TextXAlignment.Left,
	TextYAlignment = Enum.TextYAlignment.Top,
})
ui.status.Parent = top

local function fieldRow(order: number, labelText: string, placeholder: string, initial: string)
	local row = create("Frame", {
		Name = labelText .. "Row",
		Size = UDim2.new(1, 0, 0, 26),
		BackgroundTransparency = 1,
		LayoutOrder = order,
	})
	create("TextLabel", {
		Size = UDim2.new(0, 52, 1, 0),
		BackgroundTransparency = 1,
		Font = Enum.Font.Gotham,
		Text = labelText,
		TextColor3 = palette.muted,
		TextSize = 12,
		TextXAlignment = Enum.TextXAlignment.Left,
	}).Parent = row

	local box = create("TextBox", {
		Position = UDim2.new(0, 56, 0, 0),
		Size = UDim2.new(1, -56, 1, 0),
		BackgroundColor3 = palette.panel,
		BorderSizePixel = 0,
		ClearTextOnFocus = false,
		Font = Enum.Font.Code,
		PlaceholderText = placeholder,
		Text = initial,
		TextColor3 = palette.text,
		TextSize = 12,
		TextXAlignment = Enum.TextXAlignment.Left,
	}, {
		create("UIPadding", { PaddingLeft = UDim.new(0, 6), PaddingRight = UDim.new(0, 6) }),
		create("UICorner", { CornerRadius = UDim.new(0, 4) }),
	})
	box.Parent = row

	return row, box
end

local portRow, portBox = fieldRow(3, "Port", "44755", tostring(loadSetting("RobloxMCP_Port", 44755)))
portRow.Parent = top
local tokenRow, tokenBox = fieldRow(4, "Token", "optional", tostring(loadSetting("RobloxMCP_Token", "")))
tokenRow.Parent = top

local buttons = create("Frame", {
	Name = "Buttons",
	Size = UDim2.new(1, 0, 0, 28),
	BackgroundTransparency = 1,
	LayoutOrder = 5,
}, {
	create("UIListLayout", {
		FillDirection = Enum.FillDirection.Horizontal,
		Padding = UDim.new(0, 6),
		SortOrder = Enum.SortOrder.LayoutOrder,
	}),
})
buttons.Parent = top

local function makeButton(text: string, color: Color3, order: number, width: number)
	local button = create("TextButton", {
		Name = text,
		Size = UDim2.new(0, width, 1, 0),
		BackgroundColor3 = color,
		BorderSizePixel = 0,
		AutoButtonColor = true,
		Font = Enum.Font.GothamBold,
		Text = text,
		TextColor3 = palette.text,
		TextSize = 12,
		LayoutOrder = order,
	}, { create("UICorner", { CornerRadius = UDim.new(0, 4) }) })
	button.Parent = buttons
	return button
end

ui.connect = makeButton("Connect", palette.accent, 1, 92)
ui.disconnect = makeButton("Disconnect", palette.panel, 2, 96)
ui.selftest = makeButton("Self-test", palette.panel, 3, 82)

ui.info = create("TextLabel", {
	Name = "Info",
	LayoutOrder = 6,
	Size = UDim2.new(1, 0, 0, 0),
	AutomaticSize = Enum.AutomaticSize.Y,
	BackgroundTransparency = 1,
	Font = Enum.Font.Gotham,
	Text = "",
	TextColor3 = palette.muted,
	TextSize = 11,
	TextWrapped = true,
	TextXAlignment = Enum.TextXAlignment.Left,
	TextYAlignment = Enum.TextYAlignment.Top,
})
ui.info.Parent = top

local logScroll = create("ScrollingFrame", {
	Name = "Log",
	Position = UDim2.new(0, 10, 0, 246),
	Size = UDim2.new(1, -20, 1, -256),
	BackgroundColor3 = Color3.fromRGB(28, 29, 33),
	BorderSizePixel = 0,
	CanvasSize = UDim2.new(0, 0, 0, 0),
	AutomaticCanvasSize = Enum.AutomaticSize.Y,
	ScrollBarImageColor3 = palette.muted,
	ScrollBarThickness = 4,
}, {
	create("UIPadding", { PaddingTop = UDim.new(0, 6), PaddingBottom = UDim.new(0, 6), PaddingLeft = UDim.new(0, 6), PaddingRight = UDim.new(0, 6) }),
	create("UIListLayout", {
		Padding = UDim.new(0, 3),
		SortOrder = Enum.SortOrder.LayoutOrder,
	}),
	create("UICorner", { CornerRadius = UDim.new(0, 4) }),
})
logScroll.Parent = root

local logCount = 0

local function logLine(text: string, color: Color3?)
	logCount += 1
	local label = create("TextLabel", {
		Name = "Line" .. tostring(logCount),
		Size = UDim2.new(1, 0, 0, 0),
		AutomaticSize = Enum.AutomaticSize.Y,
		BackgroundTransparency = 1,
		Font = Enum.Font.Code,
		Text = ("%s  %s"):format(os.date("%H:%M:%S"), text),
		TextColor3 = color or palette.text,
		TextSize = 11,
		TextWrapped = true,
		TextXAlignment = Enum.TextXAlignment.Left,
		TextYAlignment = Enum.TextYAlignment.Top,
		LayoutOrder = logCount,
	})
	label.Parent = logScroll

	local lines = {}
	for _, child in ipairs(logScroll:GetChildren()) do
		if child:IsA("TextLabel") then
			table.insert(lines, child)
		end
	end
	if #lines > 120 then
		for index = 1, #lines - 120 do
			lines[index]:Destroy()
		end
	end
	logScroll.CanvasPosition = Vector2.new(0, 1e6)
end

local function setStatus(text: string, connected: boolean?)
	ui.status.Text = text
	if connected == nil then
		return
	end
	state.connected = connected
	ui.dot.BackgroundColor3 = connected and palette.ok or palette.bad
end

local function updateInfo()
	local mode = RunService:IsRunning() and "play" or "edit"
	ui.info.Text = ("%s  |  %s mode  |  %d calls served  |  port %d"):format(game.Name, mode, state.served, state.port)
end

-- -------------------------------------------------------------------- bridge

local function flushLogs()
	if not currentApi or #pendingLogs == 0 then
		return
	end
	local batch = pendingLogs
	pendingLogs = {}
	for _, entry in ipairs(batch) do
		currentApi:post("/v1/event", { type = "log", data = entry })
	end
end

local function queueLog(entry)
	table.insert(pendingLogs, entry)
	if #pendingLogs > 100 then
		table.remove(pendingLogs, 1)
	end
end

local function respond(api, id: string, ok: boolean, result: any, err: any)
	local payload = { id = id, ok = ok }
	if ok then
		local encodedOk, encoded = pcall(Codec.encode, result)
		if encodedOk then
			payload.result = encoded
		else
			payload.ok = false
			payload.error = { code = "encode_failed", message = "could not encode result: " .. tostring(encoded) }
		end
	else
		payload.error = err
	end
	api:post("/v1/result", payload)
end

local function dispatch(api, request)
	local method = tostring(request.method or "")
	local params = type(request.params) == "table" and request.params or {}
	local handler = Ops[method]

	if type(handler) ~= "function" then
		respond(api, request.id, false, nil, {
			code = "unknown_method",
			message = ("RobloxMCP has no method %q. Update the plugin and server together."):format(method),
		})
		return
	end

	local recording = nil
	if not Ops.noRecording[method] then
		pcall(function()
			recording = ChangeHistoryService:TryBeginRecording("RobloxMCP: " .. method)
		end)
	end

	local ok, result = pcall(handler, params)

	if recording then
		pcall(function()
			ChangeHistoryService:FinishRecording(
				recording,
				ok and Enum.FinishRecordingOperation.Commit or Enum.FinishRecordingOperation.Cancel
			)
		end)
	end

	if ok then
		respond(api, request.id, true, result)
	else
		local err
		if type(result) == "table" and result.code then
			err = { code = tostring(result.code), message = tostring(result.message) }
		else
			err = { code = "studio_error", message = tostring(result) }
		end
		logLine(err.message, palette.bad)
		respond(api, request.id, false, nil, err)
	end
end

local function helloPayload()
	local placeId = 0
	pcall(function()
		placeId = game.PlaceId
	end)
	local studioVersion = ""
	pcall(function()
		studioVersion = version()
	end)
	return {
		protocol = PROTOCOL,
		placeName = game.Name,
		placeId = placeId,
		pluginVersion = Ops.PLUGIN_VERSION,
		studioVersion = studioVersion,
		mode = RunService:IsRunning() and "play" or "edit",
	}
end

local function connectLoop()
	while true do
		if state.running then
			local api = Api.new(state.port, state.token)
			local ok, hello = api:post("/v1/hello", helloPayload())

			if not ok then
				setStatus(("Waiting for the MCP server on port %d: %s"):format(state.port, tostring(hello)), false)
				state.lastError = tostring(hello)
				task.wait(2)
			else
				currentApi = api
				state.lastError = ""
				setStatus(("Connected to MCP server %s (port %d)"):format(tostring(type(hello) == "table" and hello.serverVersion or "?"), state.port), true)
				logLine(("connected on port %d"):format(state.port), palette.ok)
				updateInfo()
				flushLogs()

				while state.running do
					local pollOk, payload = api:get(("/v1/poll?timeout=%d"):format(POLL_TIMEOUT_SECONDS))
					if not pollOk then
						setStatus(("Disconnected: %s"):format(tostring(payload)), false)
						logLine("poll failed: " .. tostring(payload), palette.bad)
						break
					end
					if payload and payload.request then
						state.served += 1
						dispatch(api, payload.request)
						updateInfo()
					end
					flushLogs()
				end

				currentApi = nil
			end
		else
			task.wait(0.25)
		end
	end
end

Ops.startLogCapture(queueLog)

-- Forward selection changes so the server (and agents) can see what is selected.
do
	local lastSent = 0
	Selection.SelectionChanged:Connect(function()
		if not state.connected or not currentApi then
			return
		end
		local now = os.clock()
		if now - lastSent < 0.4 then
			return
		end
		lastSent = now
		local selected = Ops.getSelection().selection
		currentApi:post("/v1/event", { type = "selection", data = selected })
	end)
end

task.spawn(function()
	while true do
		task.wait(1)
		if state.connected then
			flushLogs()
		end
	end
end)

-- ------------------------------------------------------------------ controls

toolbarButton.Click:Connect(function()
	widget.Enabled = not widget.Enabled
end)

ui.connect.MouseButton1Click:Connect(function()
	local port = math.floor(tonumber(portBox.Text) or 0)
	if port <= 0 or port > 65535 then
		setStatus("Port must be a number between 1 and 65535.", false)
		return
	end
	state.port = port
	state.token = tokenBox.Text
	saveSetting("RobloxMCP_Port", port)
	saveSetting("RobloxMCP_Token", state.token)
	state.running = true
	setStatus(("Connecting to 127.0.0.1:%d ..."):format(port), false)
	updateInfo()
end)

ui.disconnect.MouseButton1Click:Connect(function()
	state.running = false
	currentApi = nil
	setStatus("Disconnected. Press Connect to attach again.", false)
end)

ui.selftest.MouseButton1Click:Connect(function()
	local ok, result = pcall(Ops.selftest)
	if not ok then
		logLine("self-test failed: " .. tostring(result), palette.bad)
		return
	end
	for _, check in ipairs(result.checks) do
		logLine(("%s: %s (%s)"):format(check.name, check.ok and "ok" or "FAIL", check.detail), check.ok and palette.text or palette.bad)
	end
end)

plugin.Unloading:Connect(function()
	state.running = false
end)

-- Startup: try once, but do not spam retries when no server is running.
task.spawn(function()
	task.wait(0.5)
	updateInfo()
	if loadSetting("RobloxMCP_ConnectOnLoad", true) == false then
		setStatus("Idle. Press Connect to attach to the MCP server.", false)
		return
	end
	state.port = math.floor(tonumber(portBox.Text) or 44755)
	state.token = tokenBox.Text
	local api = Api.new(state.port, state.token)
	local ok, hello = api:post("/v1/hello", helloPayload())
	if ok then
		state.running = true
		logLine(("auto-connected on port %d"):format(state.port), palette.ok)
	else
		setStatus(("MCP server not running on port %d. Start it with `npm start`, then press Connect.\n%s"):format(state.port, tostring(hello)), false)
	end
end)

task.spawn(connectLoop)
logLine("plugin loaded", palette.muted)
