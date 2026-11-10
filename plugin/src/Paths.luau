--!nonstrict
-- Resolves and prints instance paths such as `Workspace.Model.Part`.
-- Dot form is used for names matching [%w_]+, bracket form for everything else.

local Paths = {}

local function fail(message: string)
	error({ code = "invalid_path", message = message }, 0)
end

local function tokenize(input: string): { string }
	local segments = {}
	local index = 1
	local length = #input

	while index <= length do
		local char = string.sub(input, index, index)

		if char == "." or char == "/" then
			index += 1
		elseif char == "[" then
			local quote = string.sub(input, index + 1, index + 1)
			if quote ~= '"' and quote ~= "'" then
				fail(("expected a quoted name after '[' at character %d of %q"):format(index, input))
			end
			local closing = string.find(input, quote, index + 2, true)
			if not closing then
				fail(("unterminated quote in path %q"):format(input))
			end
			local name = string.sub(input, index + 2, closing - 1)
			name = string.gsub(name, '\\"', '"')
			table.insert(segments, name)
			index = closing + 1
			if string.sub(input, index, index) == "]" then
				index += 1
			end
		else
			local startIndex, endIndex = string.find(input, "^[%w_]+", index)
			if not startIndex then
				fail(("unexpected character %q at position %d of path %q"):format(char, index, input))
			end
			table.insert(segments, string.sub(input, startIndex, endIndex))
			index = endIndex + 1
		end
	end

	return segments
end

function Paths.escapeName(name: string): string
	if string.match(name, "^[%w_]+$") then
		return name
	end
	return '["' .. string.gsub(name, '"', '\\"') .. '"]'
end

-- Human readable path for an instance, rooted at `game`.
function Paths.of(instance: Instance): string
	local parts = {}
	local current: Instance? = instance

	while current and current ~= game do
		table.insert(parts, 1, Paths.escapeName(current.Name))
		current = current.Parent
	end

	if #parts == 0 then
		return "game"
	end

	return "game." .. table.concat(parts, ".")
end

function Paths.resolve(path: string?): Instance
	if path == nil or path == "" or path == "game" or path == "." then
		return game
	end

	local segments = tokenize(path)
	local current: Instance = game

	for _, segment in ipairs(segments) do
		if segment == "game" and current == game then
			continue
		end

		local child: Instance?
		if current == game then
			child = game:FindFirstChild(segment)
			if not child then
				local ok, service = pcall(function()
					return game:GetService(segment)
				end)
				if ok then
					child = service
				end
			end
		else
			child = current:FindFirstChild(segment)
		end

		if not child then
			fail(("no instance named %q under %s"):format(segment, current:GetFullName()))
		end

		current = child
	end

	return current
end

function Paths.isDescendantOf(instance: Instance, possibleAncestor: Instance): boolean
	local current = instance.Parent
	while current do
		if current == possibleAncestor then
			return true
		end
		current = current.Parent
	end
	return false
end

return Paths
