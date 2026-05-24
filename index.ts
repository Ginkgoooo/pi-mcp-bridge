import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { Type } from "typebox";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

interface McpServerConfig {
	command: string;
	args?: string[];
	env?: Record<string, string>;
	cwd?: string;
	enabled?: boolean;
	toolAllowlist?: string[];
	toolDenylist?: string[];
	timeoutMs?: number;
	label?: string;
}

type McpServers = Record<string, McpServerConfig>;

type PiContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

interface ActiveConnection {
	key: string;
	label: string;
	config: McpServerConfig;
	client: Client;
	transport: StdioClientTransport;
	pid?: number;
	toolCount: number;
	tools: string[];
	status: "connected" | "closed" | "error";
	error?: string;
	stderr: string[];
}

const activeConnections: ActiveConnection[] = [];
const MAX_STDERR_LINES = 80;
const DEFAULT_TIMEOUT_MS = 60_000;

export default async function mcpBridge(pi: ExtensionAPI) {
	const servers = readMcpServers(process.cwd());
	const enabledServers = Object.entries(servers).filter(([, cfg]) => cfg?.enabled === true);

	for (const [key, cfg] of enabledServers) {
		try {
			await connectAndRegister(pi, key, normalizeConfig(cfg));
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			activeConnections.push({
				key,
				label: cfg.label ?? key,
				config: cfg,
				client: undefined as unknown as Client,
				transport: undefined as unknown as StdioClientTransport,
				toolCount: 0,
				tools: [],
				status: "error",
				error: message,
				stderr: [],
			});
			console.error(`[mcp-bridge] Failed to connect ${key}: ${message}`);
		}
	}

	pi.on("session_shutdown", async () => {
		await closeAllConnections();
	});

	pi.registerCommand("mcp", {
		description: "List connected MCP servers and tools",
		getArgumentCompletions: (prefix) => {
			const values = ["tools", "logs"];
			const filtered = values.filter((value) => value.startsWith(prefix.trim()));
			return filtered.length ? filtered.map((value) => ({ value, label: value })) : null;
		},
		handler: async (args, ctx) => {
			const [subcommand, serverKey] = args.trim().split(/\s+/, 2);
			if (subcommand === "tools") {
				const lines = activeConnections
					.filter((connection) => !serverKey || connection.key === serverKey)
					.flatMap((connection) => [
						`• ${connection.key} (${connection.status})`,
						...(connection.tools.length ? connection.tools.map((tool) => `  - ${connection.key}__${tool}`) : ["  (no tools)"]),
					]);
				ctx.ui.notify(lines.join("\n") || "(no MCP servers)", "info");
				return;
			}

			if (subcommand === "logs") {
				const lines = activeConnections
					.filter((connection) => !serverKey || connection.key === serverKey)
					.flatMap((connection) => [
						`• ${connection.key} stderr:`,
						...(connection.stderr.length ? connection.stderr.map((line) => `  ${line}`) : ["  (empty)"]),
					]);
				ctx.ui.notify(lines.join("\n") || "(no MCP servers)", "info");
				return;
			}

			const lines = activeConnections.map((connection) => {
				const pid = connection.pid === undefined ? "-" : String(connection.pid);
				const suffix = connection.error ? `  error=${connection.error}` : "";
				return `• ${connection.key}  pid=${pid}  tools=${connection.toolCount}  status=${connection.status}${suffix}`;
			});
			ctx.ui.notify(lines.join("\n") || "(no MCP servers)", "info");
		},
	});
}

async function closeAllConnections(): Promise<void> {
	const connections = activeConnections.splice(0, activeConnections.length);
	await Promise.all(
		connections.map(async (connection) => {
			try {
				await connection.client?.close();
			} catch {
				// ignore shutdown errors
			}
			try {
				await connection.transport?.close();
			} catch {
				// ignore shutdown errors
			}
			connection.status = "closed";
		}),
	);
}

async function connectAndRegister(pi: ExtensionAPI, key: string, cfg: McpServerConfig): Promise<void> {
	validateServerKey(key);
	const label = cfg.label ?? key;
	const transport = new StdioClientTransport({
		command: resolveWindowsCommand(cfg.command),
		args: cfg.args ?? [],
		env: { ...process.env, ...(cfg.env ?? {}) } as Record<string, string>,
		cwd: cfg.cwd,
		stderr: "pipe",
	});
	const client = new Client({ name: "pi-mcp-bridge", version: "0.1.0" }, { capabilities: {} });
	const connection: ActiveConnection = {
		key,
		label,
		config: cfg,
		client,
		transport,
		toolCount: 0,
		tools: [],
		status: "connected",
		stderr: [],
	};

	transport.onerror = (error) => {
		connection.status = "error";
		connection.error = error instanceof Error ? error.message : String(error);
	};
	transport.onclose = () => {
		if (connection.status !== "error") connection.status = "closed";
	};

	transport.stderr?.on("data", (chunk: Buffer) => {
		for (const line of chunk.toString("utf8").split(/\r?\n/)) {
			if (!line.trim()) continue;
			connection.stderr.push(line);
			if (connection.stderr.length > MAX_STDERR_LINES) connection.stderr.splice(0, connection.stderr.length - MAX_STDERR_LINES);
		}
	});

	await client.connect(transport);
	connection.pid = transport.pid;
	activeConnections.push(connection);

	const { tools } = await client.listTools(undefined, { timeout: cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS });
	for (const tool of tools) {
		if (!shouldExposeTool(tool, cfg)) continue;
		registerMcpTool(pi, connection, tool);
		connection.toolCount += 1;
		connection.tools.push(tool.name);
	}
}

function registerMcpTool(pi: ExtensionAPI, connection: ActiveConnection, tool: Tool): void {
	const piToolName = `${connection.key}__${tool.name}`;
	pi.registerTool({
		name: piToolName,
		label: `${connection.label}: ${tool.title ?? tool.name}`,
		description: `${tool.description ?? "MCP tool"}\n\n[MCP: ${connection.key}]`,
		promptSnippet: `${connection.label}: ${tool.description ?? tool.title ?? tool.name}`,
		parameters: Type.Any(),
		async execute(_toolCallId, params, signal, onUpdate) {
			const result = await connection.client.callTool(
				{ name: tool.name, arguments: isPlainObject(params) ? (params as Record<string, unknown>) : {} },
				undefined,
				{
					signal,
					timeout: connection.config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
					resetTimeoutOnProgress: true,
					onprogress: (progress) => {
						const pct =
							typeof progress.total === "number" && progress.total > 0
								? ` ${Math.round((progress.progress / progress.total) * 100)}%`
								: "";
						const message = progress.message ? ` ${progress.message}` : "";
						onUpdate?.({
							content: [{ type: "text", text: `MCP ${connection.key}/${tool.name}:${pct}${message}`.trim() }],
							details: { mcp: { server: connection.key, tool: tool.name, progress } },
						});
					},
				},
			);

			const callResult = result as CallToolResult;
			if (callResult.isError) {
				throw new Error(contentToErrorText(callResult));
			}

			return {
				content: mapMcpContent(callResult),
				details: { mcp: { server: connection.key, tool: tool.name, raw: callResult } },
			};
		},
	});
}

function mapMcpContent(result: CallToolResult): PiContent[] {
	const mapped: PiContent[] = [];

	for (const block of result.content ?? []) {
		if (block.type === "text") {
			mapped.push({ type: "text", text: block.text });
			continue;
		}

		if (block.type === "image") {
			mapped.push({ type: "image", data: block.data, mimeType: block.mimeType });
			continue;
		}

		if (block.type === "resource") {
			const resource = block.resource;
			if ("text" in resource) {
				mapped.push({ type: "text", text: `[resource: ${resource.uri}]\n${resource.text}` });
			} else {
				mapped.push({
					type: "text",
					text: `[resource: ${resource.uri}]\n(binary blob, ${base64ByteLength(resource.blob)} bytes, mimeType=${resource.mimeType ?? "unknown"})`,
				});
			}
			continue;
		}

		if (block.type === "resource_link") {
			mapped.push({
				type: "text",
				text: `[resource link: ${block.uri}] ${block.title ?? block.name}${block.description ? `\n${block.description}` : ""}`,
			});
			continue;
		}

		mapped.push({ type: "text", text: `[unsupported MCP content]\n${safeJson(block)}` });
	}

	if (result.structuredContent !== undefined) {
		mapped.push({ type: "text", text: `[structured content]\n${safeJson(result.structuredContent)}` });
	}

	return mapped.length ? mapped : [{ type: "text", text: "(empty MCP result)" }];
}

function contentToErrorText(result: CallToolResult): string {
	return mapMcpContent(result)
		.map((block) => (block.type === "text" ? block.text : `[image: ${block.mimeType}, ${block.data.length} base64 chars]`))
		.join("\n") || "MCP tool returned an error";
}

function shouldExposeTool(tool: Tool, cfg: McpServerConfig): boolean {
	if (cfg.toolAllowlist && !cfg.toolAllowlist.includes(tool.name)) return false;
	if (cfg.toolDenylist?.includes(tool.name)) return false;
	return true;
}

function normalizeConfig(cfg: McpServerConfig): McpServerConfig {
	return {
		...cfg,
		args: Array.isArray(cfg.args) ? cfg.args.map(String) : [],
		env: cfg.env ? Object.fromEntries(Object.entries(cfg.env).map(([k, v]) => [k, String(v)])) : undefined,
		cwd: cfg.cwd ? expandHome(cfg.cwd) : undefined,
		timeoutMs: typeof cfg.timeoutMs === "number" ? cfg.timeoutMs : DEFAULT_TIMEOUT_MS,
	};
}

function readMcpServers(cwd: string): McpServers {
	const globalSettingsPath = join(homedir(), ".pi", "agent", "settings.json");
	const projectSettingsPath = join(cwd, ".pi", "settings.json");
	const globalSettings = readJsonObject(globalSettingsPath);
	const projectSettings = readJsonObject(projectSettingsPath);
	return mergeMcpServers(globalSettings.mcpServers, projectSettings.mcpServers);
}

function mergeMcpServers(globalValue: unknown, projectValue: unknown): McpServers {
	const globalServers = isPlainObject(globalValue) ? (globalValue as Record<string, unknown>) : {};
	const projectServers = isPlainObject(projectValue) ? (projectValue as Record<string, unknown>) : {};
	const result: McpServers = {};

	for (const key of new Set([...Object.keys(globalServers), ...Object.keys(projectServers)])) {
		const base = isPlainObject(globalServers[key]) ? (globalServers[key] as Record<string, unknown>) : {};
		const override = isPlainObject(projectServers[key]) ? (projectServers[key] as Record<string, unknown>) : {};
		const merged = { ...base, ...override };
		if (typeof merged.command === "string" && merged.command.trim()) {
			result[key] = merged as unknown as McpServerConfig;
		}
	}

	return result;
}

function readJsonObject(path: string): Record<string, unknown> {
	try {
		if (!existsSync(path)) return {};
		const value = JSON.parse(readFileSync(path, "utf8"));
		return isPlainObject(value) ? (value as Record<string, unknown>) : {};
	} catch (error) {
		console.error(`[mcp-bridge] Failed to read ${path}: ${error instanceof Error ? error.message : String(error)}`);
		return {};
	}
}

function validateServerKey(key: string): void {
	if (!/^[A-Za-z0-9_-]+$/.test(key)) {
		throw new Error(`Invalid MCP server key "${key}". Use only letters, numbers, '_' and '-'.`);
	}
}

function resolveWindowsCommand(command: string): string {
	if (process.platform !== "win32") return expandHome(command);
	const expanded = expandHome(command);
	if (/[\\/]npx$/i.test(expanded) || expanded.toLowerCase() === "npx") return "npx.cmd";
	return expanded;
}

function expandHome(value: string): string {
	if (value === "~") return homedir();
	if (value.startsWith("~/") || value.startsWith("~\\")) return join(homedir(), value.slice(2));
	return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function base64ByteLength(base64: string): number {
	try {
		return Buffer.byteLength(base64, "base64");
	} catch {
		return base64.length;
	}
}

function safeJson(value: unknown): string {
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}
