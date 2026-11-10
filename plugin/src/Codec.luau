--!nonstrict
-- Converts Roblox datatypes to readable JSON and back.
--
-- Wire format examples:
--   Vector3   { "__type": "Vector3", "x": 0, "y": 5, "z": 0 }
--   CFrame    { "__type": "CFrame", "components": [12 numbers] }
--   Color3    { "__type": "Color3", "r": 1, "g": 0.5, "b": 0 }
--   UDim2     { "__type": "UDim2", "xs": 0, "xo": 100, "ys": 0, "yo": 50 }
--   Enum      { "__type": "Enum", "enumType": "Material", "name": "Neon" }
--   Instance  { "__type": "Instance", "path": "game.Workspace.Part" }

local Paths = require(script.Parent.Paths)

local Codec = {}

local MAX_DEPTH = 10
local MAX_STRING = 250_000

local function numberOr(value: any, fallback: number): number
	if type(value) == "number" then
		return value
	end
	local parsed = tonumber(value)
	return parsed or fallback
end

local function color(value: Color3)
	return { __type = "Color3", r = value.R, g = value.G, b = value.B }
end

local function encodeNumber(value: number): any
	if value ~= value then
		return { __type = "number", value = "nan" }
	end
	if value == math.huge then
		return { __type = "number", value = "inf" }
	end
	if value == -math.huge then
		return { __type = "number", value = "-inf" }
	end
	return value
end

-- `Enum.Material.Name` is not readable from plugins in every Studio build, so
-- derive the enum type from the item's string form ("Enum.Material.Neon").
function Codec.enumInfo(enumItem: any): (string?, string?)
	local ok, text = pcall(tostring, enumItem)
	if not ok or type(text) ~= "string" then
		return nil, nil
	end
	return string.match(text, "^Enum%.([%w_]+)%.([%w_]+)$")
end

function Codec.enumTypeName(enumItem: any): string?
	local enumName = Codec.enumInfo(enumItem)
	return enumName
end

local function encodeValue(value: any, depth: number, seen: { [any]: boolean }): any
	if value == nil then
		return nil
	end

	local valueType = typeof(value)
	if valueType == "string" then
		if #value > MAX_STRING then
			return string.sub(value, 1, MAX_STRING) .. "\n-- [truncated by RobloxMCP]"
		end
		return value
	elseif valueType == "boolean" then
		return value
	elseif valueType == "number" then
		return encodeNumber(value)
	elseif valueType == "Instance" then
		return { __type = "Instance", path = Paths.of(value), className = value.ClassName }
	elseif valueType == "EnumItem" then
		local enumType, itemName = Codec.enumInfo(value)
		return { __type = "Enum", enumType = enumType, name = itemName or tostring(value), value = value.Value }
	elseif valueType == "Vector3" then
		return { __type = "Vector3", x = value.X, y = value.Y, z = value.Z }
	elseif valueType == "Vector2" then
		return { __type = "Vector2", x = value.X, y = value.Y }
	elseif valueType == "CFrame" then
		local components = { value:GetComponents() }
		return { __type = "CFrame", components = components, position = { value.X, value.Y, value.Z } }
	elseif valueType == "Color3" then
		return color(value)
	elseif valueType == "BrickColor" then
		return { __type = "BrickColor", name = value.Name, number = value.Number }
	elseif valueType == "UDim" then
		return { __type = "UDim", scale = value.Scale, offset = value.Offset }
	elseif valueType == "UDim2" then
		return { __type = "UDim2", xs = value.X.Scale, xo = value.X.Offset, ys = value.Y.Scale, yo = value.Y.Offset }
	elseif valueType == "Rect" then
		return { __type = "Rect", minX = value.Min.X, minY = value.Min.Y, maxX = value.Max.X, maxY = value.Max.Y }
	elseif valueType == "NumberRange" then
		return { __type = "NumberRange", min = value.Min, max = value.Max }
	elseif valueType == "NumberSequence" then
		local keypoints = {}
		for _, keypoint in ipairs(value.Keypoints) do
			table.insert(keypoints, { time = keypoint.Time, value = keypoint.Value, envelope = keypoint.Envelope })
		end
		return { __type = "NumberSequence", keypoints = keypoints }
	elseif valueType == "ColorSequence" then
		local keypoints = {}
		for _, keypoint in ipairs(value.Keypoints) do
			table.insert(keypoints, { time = keypoint.Time, color = color(keypoint.Value), envelope = keypoint.Envelope })
		end
		return { __type = "ColorSequence", keypoints = keypoints }
	elseif valueType == "PhysicalProperties" then
		return {
			__type = "PhysicalProperties",
			density = value.Density,
			friction = value.Friction,
			elasticity = value.Elasticity,
			frictionWeight = value.FrictionWeight,
			elasticityWeight = value.ElasticityWeight,
		}
	elseif valueType == "Font" then
		return { __type = "Font", family = value.Family, weight = value.Weight.Name, style = value.Style.Name }
	elseif valueType == "TweenInfo" then
		return {
			__type = "TweenInfo",
			time = value.Time,
			delayTime = value.DelayTime,
			repeatCount = value.RepeatCount,
			reverses = value.Reverses,
			easingStyle = value.EasingStyle.Name,
			easingDirection = value.EasingDirection.Name,
		}
	elseif valueType == "Axes" then
		return { __type = "Axes", x = value.X, y = value.Y, z = value.Z }
	end

	if type(value) == "table" then
		if depth >= MAX_DEPTH then
			return "[max-depth]"
		end
		if seen[value] then
			return "[cycle]"
		end
		seen[value] = true

		local count = 0
		local isArray = true
		for key in pairs(value) do
			count += 1
			if type(key) ~= "number" then
				isArray = false
				break
			end
		end
		if isArray then
			for index = 1, count do
				if value[index] == nil then
					isArray = false
					break
				end
			end
		end

		local encoded
		if isArray then
			encoded = {}
			for index = 1, count do
				encoded[index] = encodeValue(value[index], depth + 1, seen)
			end
		else
			encoded = {}
			for key, item in pairs(value) do
				local keyName = type(key) == "string" and key or tostring(key)
				encoded[keyName] = encodeValue(item, depth + 1, seen)
			end
		end

		seen[value] = nil
		return encoded
	end

	return { __type = valueType, value = tostring(value) }
end

function Codec.encode(value: any): any
	return encodeValue(value, 0, {})
end

-- --------------------------------------------------------------- datatypes

local function toVector3(value: any): Vector3?
	if typeof(value) == "Vector3" then
		return value
	end
	if type(value) == "table" then
		if value.x ~= nil and value.y ~= nil and value.z ~= nil then
			return Vector3.new(numberOr(value.x, 0), numberOr(value.y, 0), numberOr(value.z, 0))
		end
		if value[1] ~= nil and value[2] ~= nil and value[3] ~= nil then
			return Vector3.new(numberOr(value[1], 0), numberOr(value[2], 0), numberOr(value[3], 0))
		end
	end
	if type(value) == "string" then
		local x, y, z = string.match(value, "^%s*([%d%.%-e]+)%s*,%s*([%d%.%-e]+)%s*,%s*([%d%.%-e]+)%s*$")
		if x then
			return Vector3.new(tonumber(x) or 0, tonumber(y) or 0, tonumber(z) or 0)
		end
	end
	return nil
end

local function toVector2(value: any): Vector2?
	if typeof(value) == "Vector2" then
		return value
	end
	if type(value) == "table" then
		if value.x ~= nil and value.y ~= nil then
			return Vector2.new(numberOr(value.x, 0), numberOr(value.y, 0))
		end
		if value[1] ~= nil and value[2] ~= nil then
			return Vector2.new(numberOr(value[1], 0), numberOr(value[2], 0))
		end
	end
	return nil
end

local function toColor3(value: any): Color3?
	if typeof(value) == "Color3" then
		return value
	end
	if type(value) == "string" then
		local hex = string.match(value, "^#?(%x%x%x%x%x%x)$")
		if hex then
			return Color3.fromHex(hex)
		end
		local ok, brick = pcall(function()
			return BrickColor.new(value)
		end)
		if ok and brick then
			return brick.Color
		end
		return nil
	end
	if type(value) == "table" then
		local r = value.r or value[1] or value.R
		local g = value.g or value[2] or value.G
		local b = value.b or value[3] or value.B
		if r ~= nil and g ~= nil and b ~= nil then
			r, g, b = numberOr(r, 0), numberOr(g, 0), numberOr(b, 0)
			if r > 1 or g > 1 or b > 1 then
				return Color3.fromRGB(r, g, b)
			end
			return Color3.new(r, g, b)
		end
	end
	return nil
end

local function toCFrame(value: any): CFrame?
	if typeof(value) == "CFrame" then
		return value
	end
	if type(value) == "table" then
		local components = value.components
		if type(components) == "table" and #components == 12 then
			return CFrame.new(unpack(components))
		end
		local position = value.position or value[1]
		if position ~= nil then
			local vector = toVector3(position)
			if vector then
				return CFrame.new(vector)
			end
		end
		local x, y, z = value.x, value.y, value.z
		if x ~= nil and y ~= nil and z ~= nil then
			return CFrame.new(numberOr(x, 0), numberOr(y, 0), numberOr(z, 0))
		end
	end
	if type(value) == "string" then
		local x, y, z = string.match(value, "^%s*([%d%.%-e]+)%s*,%s*([%d%.%-e]+)%s*,%s*([%d%.%-e]+)%s*$")
		if x then
			return CFrame.new(tonumber(x) or 0, tonumber(y) or 0, tonumber(z) or 0)
		end
	end
	return nil
end

local function toUDim(value: any): UDim?
	if typeof(value) == "UDim" then
		return value
	end
	if type(value) == "table" and value.scale ~= nil and value.offset ~= nil then
		return UDim.new(numberOr(value.scale, 0), numberOr(value.offset, 0))
	end
	if type(value) == "number" then
		return UDim.new(0, value)
	end
	return nil
end

local function toUDim2(value: any): UDim2?
	if typeof(value) == "UDim2" then
		return value
	end
	if type(value) == "table" then
		if value.xs ~= nil and value.xo ~= nil and value.ys ~= nil and value.yo ~= nil then
			return UDim2.new(numberOr(value.xs, 0), numberOr(value.xo, 0), numberOr(value.ys, 0), numberOr(value.yo, 0))
		end
		if value[1] ~= nil and value[2] ~= nil and value[3] ~= nil and value[4] ~= nil then
			return UDim2.new(numberOr(value[1], 0), numberOr(value[2], 0), numberOr(value[3], 0), numberOr(value[4], 0))
		end
		if value.x ~= nil and value.y ~= nil then
			local x = toUDim(value.x)
			local y = toUDim(value.y)
			if x and y then
				return UDim2.new(x, y)
			end
		end
	end
	if type(value) == "string" then
		local xs, xo, ys, yo = string.match(value, "^%s*([%d%.%-]+)%s*,%s*([%d%.%-]+)%s*,%s*([%d%.%-]+)%s*,%s*([%d%.%-]+)%s*$")
		if xs then
			return UDim2.new(tonumber(xs) or 0, tonumber(xo) or 0, tonumber(ys) or 0, tonumber(yo) or 0)
		end
	end
	return nil
end

local function toRect(value: any): Rect?
	if typeof(value) == "Rect" then
		return value
	end
	if type(value) == "table" then
		if value.minX ~= nil and value.maxX ~= nil then
			return Rect.new(value.minX, value.minY or 0, value.maxX, value.maxY or 0)
		end
		if value[1] ~= nil and value[2] ~= nil and value[3] ~= nil and value[4] ~= nil then
			return Rect.new(value[1], value[2], value[3], value[4])
		end
	end
	return nil
end

local function toNumberRange(value: any): NumberRange?
	if typeof(value) == "NumberRange" then
		return value
	end
	if type(value) == "table" and value.min ~= nil and value.max ~= nil then
		return NumberRange.new(numberOr(value.min, 0), numberOr(value.max, 0))
	end
	if type(value) == "number" then
		return NumberRange.new(value)
	end
	return nil
end

local function toNumberSequence(value: any): NumberSequence?
	if typeof(value) == "NumberSequence" then
		return value
	end
	if type(value) == "table" and type(value.keypoints) == "table" then
		local points = {}
		for _, point in ipairs(value.keypoints) do
			table.insert(points, NumberSequenceKeypoint.new(numberOr(point.time, 0), numberOr(point.value, 0), numberOr(point.envelope, 0)))
		end
		if #points > 0 then
			return NumberSequence.new(points)
		end
	end
	if type(value) == "number" then
		return NumberSequence.new(value)
	end
	return nil
end

local function toColorSequence(value: any): ColorSequence?
	if typeof(value) == "ColorSequence" then
		return value
	end
	if type(value) == "table" and type(value.keypoints) == "table" then
		local points = {}
		for _, point in ipairs(value.keypoints) do
			local pointColor = toColor3(point.color) or Color3.new(1, 1, 1)
			table.insert(points, ColorSequenceKeypoint.new(numberOr(point.time, 0), pointColor))
		end
		if #points > 0 then
			return ColorSequence.new(points)
		end
	end
	return nil
end

local function toPhysicalProperties(value: any): PhysicalProperties?
	if typeof(value) == "PhysicalProperties" then
		return value
	end
	if type(value) == "table" then
		return PhysicalProperties.new(
			numberOr(value.density, 0.7),
			numberOr(value.friction, 0.3),
			numberOr(value.elasticity, 0.5),
			numberOr(value.frictionWeight, 1),
			numberOr(value.elasticityWeight, 1)
		)
	end
	return nil
end

local function toFont(value: any): Font?
	if typeof(value) == "Font" then
		return value
	end
	if type(value) == "table" and value.family then
		local weight = value.weight and Enum.FontWeight[value.weight] or Enum.FontWeight.Regular
		local style = value.style and Enum.FontStyle[value.style] or Enum.FontStyle.Normal
		return Font.new(value.family, weight, style)
	end
	if type(value) == "string" then
		return Font.new(value)
	end
	return nil
end

local function toEnumItem(value: any, enumTypeName: string?): (EnumItem?, string?)
	if typeof(value) == "EnumItem" then
		return value
	end
	if type(value) == "number" and enumTypeName then
		local enum = Enum[enumTypeName]
		if enum then
			local ok, item = pcall(function()
				return enum:FromValue(value)
			end)
			if ok then
				return item
			end
		end
	end
	local name: string?
	if type(value) == "string" then
		local enumName, itemName = string.match(value, "^Enum%.([%w_]+)%.([%w_]+)$")
		if enumName then
			local enum = Enum[enumName]
			if not enum then
				return nil, ("Enum.%s does not exist"):format(enumName)
			end
			local item = enum[itemName]
			if not item then
				return nil, ("Enum.%s has no item %q"):format(enumName, itemName)
			end
			return item
		end
		name = value
	elseif type(value) == "table" then
		enumTypeName = value.enumType or enumTypeName
		name = value.name
	end

	if name and enumTypeName then
		local enum = Enum[enumTypeName]
		if not enum then
			return nil, ("Enum.%s does not exist"):format(enumTypeName)
		end
		local item = enum[name]
		if not item then
			local lower = string.lower(name)
			for _, candidate in ipairs(enum:GetEnumItems()) do
				if string.lower(candidate.Name) == lower then
					return candidate
				end
			end
			return nil, ("Enum.%s has no item %q"):format(enumTypeName, name)
		end
		return item
	end

	return nil, "expected an enum name such as \"Neon\" or \"Enum.Material.Neon\""
end

function Codec.decode(value: any): any
	if type(value) ~= "table" then
		return value
	end

	local tag = value.__type
	if tag == "Vector3" then
		return toVector3(value)
	elseif tag == "Vector2" then
		return toVector2(value)
	elseif tag == "CFrame" then
		return toCFrame(value)
	elseif tag == "Color3" then
		return toColor3(value)
	elseif tag == "BrickColor" then
		return BrickColor.new(value.name or value.number)
	elseif tag == "UDim" then
		return toUDim(value)
	elseif tag == "UDim2" then
		return toUDim2(value)
	elseif tag == "Rect" then
		return toRect(value)
	elseif tag == "NumberRange" then
		return toNumberRange(value)
	elseif tag == "NumberSequence" then
		return toNumberSequence(value)
	elseif tag == "ColorSequence" then
		return toColorSequence(value)
	elseif tag == "PhysicalProperties" then
		return toPhysicalProperties(value)
	elseif tag == "Font" then
		return toFont(value)
	elseif tag == "Enum" then
		return toEnumItem(value)
	elseif tag == "Instance" then
		return Paths.resolve(value.path)
	elseif tag == "number" then
		if value.value == "nan" then
			return 0 / 0
		elseif value.value == "inf" then
			return math.huge
		elseif value.value == "-inf" then
			return -math.huge
		end
		return tonumber(value.value) or 0
	end

	-- Plain table: decode children.
	local decoded = {}
	for key, item in pairs(value) do
		decoded[key] = Codec.decode(item)
	end
	return decoded
end

-- Coerce `value` into the type the property currently holds.
function Codec.forProperty(instance: Instance, propertyName: string, value: any): any
	if value == nil then
		return nil
	end

	local ok, current = pcall(function()
		return (instance :: any)[propertyName]
	end)
	local currentType = ok and typeof(current) or nil

	if currentType == "EnumItem" then
		local item, message = toEnumItem(value, Codec.enumTypeName(current))
		if not item then
			error(message, 0)
		end
		return item
	elseif currentType == "Instance" then
		if typeof(value) == "Instance" then
			return value
		end
		return Paths.resolve(tostring(value))
	elseif currentType == "Vector3" then
		return toVector3(value) or error(("expected Vector3 for %s, got %s"):format(propertyName, typeof(value)), 0)
	elseif currentType == "Vector2" then
		return toVector2(value) or error(("expected Vector2 for %s, got %s"):format(propertyName, typeof(value)), 0)
	elseif currentType == "CFrame" then
		return toCFrame(value) or error(("expected CFrame for %s, got %s"):format(propertyName, typeof(value)), 0)
	elseif currentType == "Color3" then
		return toColor3(value) or error(("expected Color3 ({\"__type\":\"Color3\",...} or \"#ff8800\") for %s"):format(propertyName), 0)
	elseif currentType == "BrickColor" then
		if typeof(value) == "BrickColor" then
			return value
		end
		local okBrick, brick = pcall(function()
			return BrickColor.new(value)
		end)
		if okBrick then
			return brick
		end
		error(("expected a BrickColor name for %s"):format(propertyName), 0)
	elseif currentType == "UDim" then
		return toUDim(value) or error(("expected UDim for %s"):format(propertyName), 0)
	elseif currentType == "UDim2" then
		return toUDim2(value) or error(("expected UDim2 for %s"):format(propertyName), 0)
	elseif currentType == "Rect" then
		return toRect(value) or error(("expected Rect for %s"):format(propertyName), 0)
	elseif currentType == "NumberRange" then
		return toNumberRange(value) or error(("expected NumberRange for %s"):format(propertyName), 0)
	elseif currentType == "NumberSequence" then
		return toNumberSequence(value) or error(("expected NumberSequence for %s"):format(propertyName), 0)
	elseif currentType == "ColorSequence" then
		return toColorSequence(value) or error(("expected ColorSequence for %s"):format(propertyName), 0)
	elseif currentType == "PhysicalProperties" then
		return toPhysicalProperties(value) or error(("expected PhysicalProperties for %s"):format(propertyName), 0)
	elseif currentType == "Font" then
		return toFont(value) or error(("expected Font for %s"):format(propertyName), 0)
	elseif currentType == "boolean" and type(value) == "string" then
		if value == "true" then
			return true
		elseif value == "false" then
			return false
		end
	elseif currentType == "number" and type(value) == "string" then
		return tonumber(value) or error(("expected a number for %s"):format(propertyName), 0)
	end

	return Codec.decode(value)
end

return Codec
