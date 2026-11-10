--!nonstrict
-- Implementation of every bridge method. Each function receives the `params`
-- table from the MCP server and returns a JSON-encodable result (Codec.encode
-- is applied by the caller) or raises { code, message }.

local ChangeHistoryService = game:GetService("ChangeHistoryService")
local HttpService = game:GetService("HttpService")
local InsertService = game:GetService("InsertService")
local LogService = game:GetService("LogService")
local RunService = game:GetService("RunService")
local Selection = game:GetService("Selection")
local StudioService = game:GetService("StudioService")

local Codec = require(script.Parent.Codec)
local Paths = require(script.Parent.Paths)

local Ops = {}
Ops.PLUGIN_VERSION = "1.0.0"
Ops.logs = {}
Ops.MAX_LOGS = 500

-- Methods that must not be wrapped in a change-history recording.
Ops.noRecording = {
	ping = true,
	getTree = true,
	getInstance = true,
	searchInstances = true,
	getSelection = true,
	getScriptSource = true,
	getLogs = true,
	selftest = true,
	history = true,
}

local scriptEditorService = nil
do
	local ok, service = pcall(function()
		return game:GetService("ScriptEditorService")
	end)
	if ok then
		scriptEditorService = service
	end
end

local COMMON_PROPERTIES = {
	"Name", "Parent", "Anchored", "CanCollide", "CanQuery", "CanTouch", "CastShadow", "Color",
	"Material", "Size", "CFrame", "Position", "Orientation", "Transparency", "Reflectance", "Massless",
	"Shape", "Enabled", "RunContext", "Source", "Text", "TextColor3", "TextSize", "Font", "Visible",
	"BackgroundColor3", "BackgroundTransparency", "BorderSizePixel", "Image", "ZIndex", "LayoutOrder",
	"Value", "PrimaryPart", "Health", "WalkSpeed", "JumpPower", "MaxHealth", "SoundId", "Volume",
	"PlaybackSpeed", "Looped", "Playing", "TimePosition", "Ambient", "Brightness", "ClockTime",
	"Density", "Friction", "Elasticity", "Gravity", "Level", "Title", "PlaceholderText", "TextEditable",
}

local function fail(code: string, message: string)
	error({ code = code, message = message }, 0)
end

local function clamp(value: number, minimum: number, maximum: number): number
	return math.min(maximum, math.max(minimum, value))
end

local function countLines(text: string): number
	local _, newlines = string.gsub(text, "\n", "")
	return newlines + 1
end

local function levelOf(messageType: EnumItem): string
	local name = messageType.Name
	if name == "MessageWarning" then
		return "warning"
	elseif name == "MessageError" then
		return "error"
	elseif name == "MessageInfo" then
		return "info"
	end
	return "message"
end

local function readSource(instance: Instance): string
	if not instance:IsA("LuaSourceContainer") then
		fail("not_a_script", ("%s (%s) is not a Script, LocalScript or ModuleScript"):format(instance.Name, instance.ClassName))
	end
	local ok, source = pcall(function()
		return (instance :: any).Source
	end)
	if not ok then
		fail("source_unavailable", ("cannot read Source of %s: %s"):format(Paths.of(instance), tostring(source)))
	end
	return source
end

local function writeSource(instance: Instance, source: string)
	local ok, message = pcall(function()
		(instance :: any).Source = source
	end)
	if not ok then
		fail("source_write_failed", ("cannot write Source of %s: %s"):format(Paths.of(instance), tostring(message)))
	end

	-- Keep an open editor tab in sync. Failure here is not fatal: the data model
	-- already holds the new source.
	if scriptEditorService then
		pcall(function()
			scriptEditorService:UpdateSourceAsync(instance, function()
				return source
			end)
		end)
	end
end

function Ops.applyProperties(instance: Instance, properties: any, attributes: any)
	local applied = {}
	local errors = {}

	for name, value in pairs(properties or {}) do
		if name ~= "Parent" and name ~= "Attributes" then
			local ok, message = pcall(function()
				(instance :: any)[name] = Codec.forProperty(instance, name, value)
			end)
			if ok then
				table.insert(applied, name)
			else
				table.insert(errors, { property = name, message = tostring(message) })
			end
		end
	end

	for name, value in pairs(attributes or {}) do
		local ok, message = pcall(function()
			instance:SetAttribute(name, value)
		end)
		if ok then
			table.insert(applied, "Attribute:" .. name)
		else
			table.insert(errors, { property = "Attribute:" .. name, message = tostring(message) })
		end
	end

	return applied, errors
end

function Ops.snapshot(instance: Instance, names: { string })
	local properties = {}
	for _, name in ipairs(names) do
		local ok, value = pcall(function()
			return (instance :: any)[name]
		end)
		if ok then
			properties[name] = Codec.encode(value)
		end
	end
	return properties
end

function Ops.defaultProperties(instance: Instance): { string }
	local names = {}
	local ok, listed = pcall(function()
		return (instance :: any):GetProperties()
	end)
	if ok and type(listed) == "table" and #listed > 0 then
		for _, name in ipairs(listed) do
			if type(name) == "string" then
				table.insert(names, name)
			end
		end
	else
		for _, name in ipairs(COMMON_PROPERTIES) do
			local readable = pcall(function()
				return (instance :: any)[name]
			end)
			if readable then
				table.insert(names, name)
			end
		end
	end
	table.sort(names)
	if #names > 120 then
		names = { table.unpack(names, 1, 120) }
	end
	return names
end

function Ops.describe(instance: Instance, depth: number, includeProperties: boolean)
	local node = {
		name = instance.Name,
		className = instance.ClassName,
		path = Paths.of(instance),
		depth = depth,
		childCount = #instance:GetChildren(),
	}
	if instance:IsA("LuaSourceContainer") then
		local ok, source = pcall(function()
			return (instance :: any).Source
		end)
		if ok then
			node.lineCount = countLines(source)
		end
	end
	if includeProperties then
		node.properties = Ops.snapshot(instance, Ops.defaultProperties(instance))
	end
	return node
end

-- ------------------------------------------------------------------- methods

function Ops.ping()
	local placeId = 0
	pcall(function()
		placeId = game.PlaceId
	end)
	local userId = 0
	pcall(function()
		userId = StudioService:GetUserId()
	end)
	local studioVersion = ""
	pcall(function()
		studioVersion = version()
	end)

	return {
		placeName = game.Name,
		placeId = placeId,
		mode = RunService:IsRunning() and "play" or "edit",
		pluginVersion = Ops.PLUGIN_VERSION,
		studioVersion = studioVersion,
		httpEnabled = HttpService.HttpEnabled,
		userId = userId,
		isRunning = RunService:IsRunning(),
	}
end

function Ops.getTree(params)
	local root = Paths.resolve(params.path)
	local depth = clamp(math.floor(tonumber(params.depth) or 2), 1, 6)
	local maxNodes = clamp(math.floor(tonumber(params.maxNodes) or 250), 1, 2000)
	local includeProperties = params.includeProperties == true
	if params.servicesOnly == true then
		root = game
		depth = 1
	end

	local nodes = {}
	local queue = { { instance = root, level = 0 } }
	local index = 1
	local truncated = false

	while queue[index] do
		local item = queue[index]
		index += 1

		if item.level > 0 then
			table.insert(nodes, Ops.describe(item.instance, item.level, includeProperties))
			if #nodes >= maxNodes then
				truncated = true
				break
			end
		end

		if item.level < depth then
			for _, child in ipairs(item.instance:GetChildren()) do
				if #nodes + (#queue - index + 1) >= maxNodes then
					truncated = true
					break
				end
				table.insert(queue, { instance = child, level = item.level + 1 })
			end
		end
	end

	if queue[index] then
		truncated = true
	end

	return {
		root = Ops.describe(root, 0, false),
		nodes = nodes,
		truncated = truncated,
		depth = depth,
		maxNodes = maxNodes,
	}
end

function Ops.searchInstances(params)
	local root = Paths.resolve(params.under or "game")
	local query = string.lower(tostring(params.query or ""))
	local className = tostring(params.className or "")
	local limit = clamp(math.floor(tonumber(params.limit) or 50), 1, 500)

	local matches = {}
	local visited = 0
	local maxVisited = 25000

	local function matchesClass(name: string): boolean
		if className == "" then
			return true
		end
		if string.sub(className, 1, 1) == "*" then
			return string.sub(name, -#className + 1) == string.sub(className, 2)
		end
		return name == className
	end

	local function visit(instance: Instance)
		if #matches >= limit or visited >= maxVisited then
			return
		end
		visited += 1

		if instance ~= root then
			local nameMatches = query == "" or string.find(string.lower(instance.Name), query, 1, true) ~= nil
			if nameMatches and matchesClass(instance.ClassName) then
				table.insert(matches, {
					path = Paths.of(instance),
					name = instance.Name,
					className = instance.ClassName,
				})
			end
		end

		for _, child in ipairs(instance:GetChildren()) do
			if #matches >= limit or visited >= maxVisited then
				return
			end
			visit(child)
		end
	end

	visit(root)

	return {
		under = Paths.of(root),
		query = query,
		className = className,
		count = #matches,
		visited = visited,
		truncated = #matches >= limit or visited >= maxVisited,
		matches = matches,
	}
end

function Ops.getInstance(params)
	local instance = Paths.resolve(params.path)
	local names = params.properties
	if type(names) ~= "table" or #names == 0 then
		names = Ops.defaultProperties(instance)
	end

	local properties = {}
	local unreadable = {}
	for _, name in ipairs(names) do
		local ok, value = pcall(function()
			return (instance :: any)[name]
		end)
		if ok then
			properties[name] = Codec.encode(value)
		else
			table.insert(unreadable, name)
		end
	end

	local tags = nil
	local okTags, instanceTags = pcall(function()
		return instance:GetTags()
	end)
	if okTags then
		tags = instanceTags
	end

	return {
		path = Paths.of(instance),
		name = instance.Name,
		className = instance.ClassName,
		parent = instance.Parent and Paths.of(instance.Parent) or nil,
		attributes = Codec.encode(instance:GetAttributes()),
		properties = properties,
		unreadable = unreadable,
		tags = tags,
	}
end

function Ops.createInstance(params)
	local className = tostring(params.className or "")
	if className == "" then
		fail("invalid_argument", "className is required")
	end

	local ok, instance = pcall(Instance.new, className)
	if not ok or not instance then
		fail("invalid_class", ("Instance.new(%q) failed: %s"):format(className, tostring(instance)))
	end

	local parent = workspace
	if params.parent ~= nil then
		parent = Paths.resolve(params.parent)
	end

	if params.name ~= nil and params.name ~= "" then
		instance.Name = tostring(params.name)
	end

	local applied, errors = Ops.applyProperties(instance, params.properties or {}, params.attributes or {})
	instance.Parent = parent

	return {
		path = Paths.of(instance),
		name = instance.Name,
		className = instance.ClassName,
		parent = Paths.of(parent),
		applied = applied,
		errors = errors,
	}
end

function Ops.setProperties(params)
	local instance = Paths.resolve(params.path)
	local applied, errors = Ops.applyProperties(instance, params.properties or {}, params.attributes or {})
	return {
		path = Paths.of(instance),
		applied = applied,
		errors = errors,
	}
end

function Ops.deleteInstance(params)
	local instance = Paths.resolve(params.path)
	if instance == game then
		fail("invalid_path", "refusing to destroy the DataModel")
	end
	local path = Paths.of(instance)
	local className = instance.ClassName
	instance:Destroy()
	return { deleted = path, className = className }
end

function Ops.cloneInstance(params)
	local instance = Paths.resolve(params.path)
	local wasArchivable = instance.Archivable
	instance.Archivable = true
	local clone = instance:Clone()
	instance.Archivable = wasArchivable

	if not clone then
		fail("clone_failed", ("Clone() returned nil for %s"):format(Paths.of(instance)))
	end

	if params.name ~= nil and params.name ~= "" then
		clone.Name = tostring(params.name)
	end

	local parent = instance.Parent or workspace
	if params.parent ~= nil then
		parent = Paths.resolve(params.parent)
	end
	clone.Parent = parent

	return { path = Paths.of(clone), name = clone.Name, className = clone.ClassName }
end

function Ops.reparentInstance(params)
	local instance = Paths.resolve(params.path)
	local parent = Paths.resolve(params.parent)

	if instance == game then
		fail("invalid_path", "refusing to move the DataModel")
	end
	if parent == instance or Paths.isDescendantOf(parent, instance) then
		fail("invalid_parent", "cannot move an instance into itself or one of its descendants")
	end

	instance.Parent = parent
	if params.name ~= nil and params.name ~= "" then
		instance.Name = tostring(params.name)
	end

	return { path = Paths.of(instance), name = instance.Name, parent = Paths.of(parent) }
end

function Ops.getScriptSource(params)
	local instance = Paths.resolve(params.path)
	local source = readSource(instance)
	return {
		path = Paths.of(instance),
		className = instance.ClassName,
		lineCount = countLines(source),
		source = source,
	}
end

function Ops.setScriptSource(params)
	local instance = Paths.resolve(params.path)
	local source = params.source
	if type(source) ~= "string" then
		fail("invalid_argument", "source must be a string")
	end
	readSource(instance)
	writeSource(instance, source)
	return {
		path = Paths.of(instance),
		lineCount = countLines(source),
		length = #source,
	}
end

function Ops.editScript(params)
	local instance = Paths.resolve(params.path)
	local find = params.find
	local replace = params.replace
	if type(find) ~= "string" or find == "" then
		fail("invalid_argument", "find must be a non-empty string")
	end
	if type(replace) ~= "string" then
		fail("invalid_argument", "replace must be a string")
	end

	local source = readSource(instance)
	local path = Paths.of(instance)

	local positions = {}
	local cursor = 1
	while true do
		local first, last = string.find(source, find, cursor, true)
		if not first then
			break
		end
		table.insert(positions, { first, last })
		cursor = last + 1
	end

	if #positions == 0 then
		fail("not_found", ("%q was not found in %s"):format(find, path))
	end

	local newSource
	local replaced
	if params.all == true then
		local pieces = {}
		local previous = 1
		for _, position in ipairs(positions) do
			table.insert(pieces, string.sub(source, previous, position[1] - 1))
			table.insert(pieces, replace)
			previous = position[2] + 1
		end
		table.insert(pieces, string.sub(source, previous))
		newSource = table.concat(pieces)
		replaced = #positions
	else
		local occurrence = params.occurrence and math.floor(tonumber(params.occurrence) or 1) or nil
		if not occurrence and #positions > 1 then
			fail(
				"ambiguous_match",
				("%q appears %d times in %s; pass occurrence = N (1-based) or all = true"):format(find, #positions, path)
			)
		end
		local index = occurrence or 1
		local position = positions[index]
		if not position then
			fail("occurrence_out_of_range", ("%q appears %d times, cannot replace occurrence %d"):format(find, #positions, index))
		end
		newSource = string.sub(source, 1, position[1] - 1) .. replace .. string.sub(source, position[2] + 1)
		replaced = 1
	end

	writeSource(instance, newSource)
	return { path = path, replaced = replaced, lineCount = countLines(newSource) }
end

function Ops.getSelection()
	local selected = Selection:Get()
	local list = {}
	for _, instance in ipairs(selected) do
		table.insert(list, { path = Paths.of(instance), name = instance.Name, className = instance.ClassName })
	end
	return { count = #list, selection = list }
end

local function focusCamera(instances: { Instance })
	local camera = workspace.CurrentCamera
	if not camera then
		return
	end

	local minimum = Vector3.new(math.huge, math.huge, math.huge)
	local maximum = Vector3.new(-math.huge, -math.huge, -math.huge)
	local found = false

	for _, instance in ipairs(instances) do
		local center: Vector3? = nil
		local size: Vector3? = nil

		if instance:IsA("BasePart") then
			center = instance.Position
			size = instance.Size
		elseif instance:IsA("Model") then
			local ok, boxCFrame, boxSize = pcall(function()
				return instance:GetBoundingBox()
			end)
			if ok then
				center = boxCFrame.Position
				size = boxSize
			end
		end

		if center and size then
			found = true
			local half = size / 2
			minimum = Vector3.new(
				math.min(minimum.X, center.X - half.X),
				math.min(minimum.Y, center.Y - half.Y),
				math.min(minimum.Z, center.Z - half.Z)
			)
			maximum = Vector3.new(
				math.max(maximum.X, center.X + half.X),
				math.max(maximum.Y, center.Y + half.Y),
				math.max(maximum.Z, center.Z + half.Z)
			)
		end
	end

	if not found then
		return
	end

	local center = (minimum + maximum) / 2
	local radius = math.max((maximum - minimum).Magnitude / 2, 4)
	camera.CFrame = CFrame.lookAt(center + Vector3.new(0, radius * 0.8, -radius * 2.2), center)
end

function Ops.setSelection(params)
	local instances = {}
	for _, path in ipairs(params.paths or {}) do
		table.insert(instances, Paths.resolve(tostring(path)))
	end
	Selection:Set(instances)
	if params.focus == true and #instances > 0 then
		pcall(focusCamera, instances)
	end
	return { count = #instances, selected = Ops.getSelection().selection }
end

function Ops.insertAsset(params)
	local assetId = math.floor(tonumber(params.assetId) or 0)
	if assetId <= 0 then
		fail("invalid_argument", "assetId must be a positive integer")
	end

	local ok, model = pcall(function()
		return InsertService:LoadAsset(assetId)
	end)
	if not ok then
		fail("insert_failed", ("InsertService:LoadAsset(%d) failed: %s"):format(assetId, tostring(model)))
	end

	local parent = Paths.resolve(params.parent or "Workspace")
	local inserted = {}
	for _, child in ipairs(model:GetChildren()) do
		if params.name ~= nil and params.name ~= "" then
			child.Name = tostring(params.name)
		end
		child.Parent = parent
		table.insert(inserted, { path = Paths.of(child), name = child.Name, className = child.ClassName })
	end
	model:Destroy()

	return { assetId = assetId, parent = Paths.of(parent), inserted = inserted }
end

function Ops.history(params)
	local action = tostring(params.action or "")
	if action == "undo" then
		local ok, message = pcall(function()
			return ChangeHistoryService:Undo()
		end)
		if not ok then
			fail("undo_failed", tostring(message))
		end
		return { action = action, waypoint = message }
	elseif action == "redo" then
		local ok, message = pcall(function()
			return ChangeHistoryService:Redo()
		end)
		if not ok then
			fail("redo_failed", tostring(message))
		end
		return { action = action, waypoint = message }
	elseif action == "waypoint" then
		local ok, message = pcall(function()
			return ChangeHistoryService:SetWaypoint("RobloxMCP waypoint")
		end)
		if not ok then
			fail("waypoint_failed", tostring(message))
		end
		return { action = action }
	end
	fail("invalid_argument", "action must be undo, redo or waypoint")
end

function Ops.getLogs(params)
	local limit = clamp(math.floor(tonumber(params.limit) or 50), 1, 500)
	local filter = tostring(params.messageType or "all")

	local selected = {}
	for _, entry in ipairs(Ops.logs) do
		if filter == "all" or entry.type == filter then
			table.insert(selected, entry)
			if #selected >= limit then
				break
			end
		end
	end

	local ordered = {}
	for index = #selected, 1, -1 do
		table.insert(ordered, selected[index])
	end

	return { lines = ordered, total = #Ops.logs, filter = filter }
end

function Ops.selftest()
	local checks = {}

	local function check(name: string, callback: () -> any)
		local ok, value = pcall(callback)
		table.insert(checks, {
			name = name,
			ok = ok,
			detail = ok and tostring(value) or tostring(value),
		})
	end

	check("instance_new", function()
		return Instance.new("Part").ClassName
	end)

	check("source_read_write", function()
		local probe = Instance.new("Script")
		probe.Source = "print('probe')"
		local source = probe.Source
		probe:Destroy()
		return source == "print('probe')" and "ok" or "Source did not round-trip"
	end)

	check("change_history_recording", function()
		local recording = ChangeHistoryService:TryBeginRecording("RobloxMCP selftest")
		if not recording then
			return "another recording is in progress"
		end
		ChangeHistoryService:FinishRecording(recording, Enum.FinishRecordingOperation.Cancel)
		return "ok"
	end)

	check("insert_service", function()
		return type(InsertService.LoadAsset) == "function" and "available" or "missing"
	end)

	check("script_editor_service", function()
		return scriptEditorService and "available" or "missing (falls back to direct Source writes)"
	end)

	check("log_capture", function()
		return #Ops.logs >= 0 and "listening" or "not listening"
	end)

	check("http", function()
		return HttpService.HttpEnabled and "HttpEnabled = true" or "HttpEnabled = false (plugin requests usually still work)"
	end)

	local studioVersion = ""
	pcall(function()
		studioVersion = version()
	end)

	return {
		pluginVersion = Ops.PLUGIN_VERSION,
		studioVersion = studioVersion,
		place = game.Name,
		checks = checks,
	}
end

function Ops.startLogCapture(onLog: ((any) -> ())?)
	Ops.onLog = onLog
	pcall(function()
		LogService.MessageOut:Connect(function(message: string, messageType: EnumItem)
			local entry = {
				at = os.date("!%Y-%m-%dT%H:%M:%SZ"),
				type = levelOf(messageType),
				text = message,
			}
			table.insert(Ops.logs, 1, entry)
			if #Ops.logs > Ops.MAX_LOGS then
				table.remove(Ops.logs)
			end
			if Ops.onLog then
				Ops.onLog(entry)
			end
		end)
	end)

	pcall(function()
		for _, entry in ipairs(LogService:GetLogHistory()) do
			local message = entry.message
			table.insert(Ops.logs, 1, {
				at = "",
				type = levelOf(entry.messageType),
				text = message,
			})
		end
		if #Ops.logs > Ops.MAX_LOGS then
			local trimmed = {}
			for index = 1, Ops.MAX_LOGS do
				trimmed[index] = Ops.logs[index]
			end
			Ops.logs = trimmed
		end
	end)

	return true
end

return Ops
