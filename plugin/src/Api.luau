--!nonstrict
local HttpService = game:GetService("HttpService")

local Api = {}
Api.__index = Api

function Api.new(port: number, token: string)
	return setmetatable({
		base = ("http://127.0.0.1:%d"):format(port),
		token = token or "",
	}, Api)
end

local function describeFailure(response)
	if type(response) ~= "table" then
		return tostring(response)
	end
	if response.StatusCode == 0 then
		return "connection refused (is the MCP server running?)"
	end
	local ok, decoded = pcall(function()
		return HttpService:JSONDecode(response.Body or "")
	end)
	if ok and type(decoded) == "table" and decoded.error and decoded.error.message then
		return tostring(decoded.error.message)
	end
	local body = response.Body or ""
	if #body > 240 then
		body = string.sub(body, 1, 240) .. "..."
	end
	return ("HTTP %d %s"):format(response.StatusCode, body)
end

function Api:request(method: string, path: string, body: any): (boolean, any)
	local options = {
		Url = self.base .. path,
		Method = method,
		Headers = {
			["Content-Type"] = "application/json",
		},
	}

	if self.token ~= "" then
		options.Headers["x-roblox-mcp-token"] = self.token
	end

	if body ~= nil then
		local okEncode, encoded = pcall(function()
			return HttpService:JSONEncode(body)
		end)
		if not okEncode then
			return false, "could not encode request body: " .. tostring(encoded)
		end
		options.Body = encoded
	end

	local ok, response = pcall(function()
		return HttpService:RequestAsync(options)
	end)
	if not ok then
		return false, tostring(response)
	end
	if type(response) ~= "table" then
		return false, "unexpected HttpService response"
	end

	if response.StatusCode == 204 then
		return true, nil
	end
	if not response.Success then
		return false, describeFailure(response)
	end
	if response.Body == nil or response.Body == "" then
		return true, nil
	end

	local okDecode, decoded = pcall(function()
		return HttpService:JSONDecode(response.Body)
	end)
	if not okDecode then
		return false, "invalid JSON from server: " .. tostring(decoded)
	end
	return true, decoded
end

function Api:get(path: string): (boolean, any)
	return self:request("GET", path, nil)
end

function Api:post(path: string, body: any): (boolean, any)
	return self:request("POST", path, body)
end

return Api
