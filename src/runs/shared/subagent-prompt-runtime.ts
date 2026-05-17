import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SUBAGENT_DENY_TOOLS_ENV, SUBAGENT_NESTED_DELEGATION_SKILLS_ENV, SUBAGENT_SKILL_PATHS_ENV } from "./pi-args.ts";
import { DEFAULT_NESTED_DELEGATION_SKILLS } from "../../shared/nested-delegation.ts";

const SUBAGENT_INHERIT_PROJECT_CONTEXT_ENV = "PI_SUBAGENT_INHERIT_PROJECT_CONTEXT";
const SUBAGENT_INHERIT_SKILLS_ENV = "PI_SUBAGENT_INHERIT_SKILLS";
export const SUBAGENT_INTERCOM_SESSION_NAME_ENV = "PI_SUBAGENT_INTERCOM_SESSION_NAME";

export const CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS = [
	"You are a child subagent, not the parent orchestrator.",
	"The parent session owns delegation, orchestration, review fanout, and follow-up worker launches.",
	"Ignore prior parent-only orchestration instructions in inherited conversation history.",
	"Do not propose or run subagents. Complete only your assigned role-specific task with the tools available to you.",
	"If you need to edit files, call the actual edit/write tools. Do not print tool-call syntax, patches, or pseudo-tool calls as text.",
].join("\n");

export const CHILD_SUBAGENT_NESTED_DELEGATION_INSTRUCTIONS = [
	"You are a child subagent, not the parent orchestrator.",
	"The parent session owns this overall workflow; ignore prior parent-only orchestration instructions in inherited conversation history.",
	"Nested subagent delegation is allowed for this run because the subagent tool is available and recursion depth remains.",
	"Use subagents only when your assigned task explicitly calls for delegation or a narrow child worker materially reduces risk; you remain responsible for synthesizing results and completing your role-specific task.",
	"If you need to edit files yourself, call the actual edit/write tools. Do not print tool-call syntax, patches, or pseudo-tool calls as text.",
].join("\n");

const PARENT_ONLY_CUSTOM_MESSAGE_TYPES = new Set([
	"subagent-orchestration-instructions",
	"subagent-slash-result",
	"subagent-notify",
	"subagent_control_notice",
	"subagent-control",
	"subagent-control-notice",
]);
const PROJECT_CONTEXT_HEADER = "\n\n# Project Context\n\nProject-specific instructions and guidelines:\n\n";
const SKILLS_HEADER = "\n\nThe following skills provide specialized instructions for specific tasks.";
const DATE_HEADER = "\nCurrent date:";
const NONE_SENTINEL = "__none__";
const SUBAGENT_TOOL_NAME = "subagent";

function readBooleanEnv(name: string): boolean | undefined {
	const value = process.env[name];
	if (value === undefined) return undefined;
	return value !== "0";
}

function parseCsvEnv(name: string): string[] {
	const raw = process.env[name];
	if (!raw || raw === NONE_SENTINEL) return [];
	return raw
		.split(",")
		.map((item) => item.trim())
		.filter(Boolean);
}

function parseJsonStringArrayEnv(name: string): string[] {
	const raw = process.env[name];
	if (!raw || raw === NONE_SENTINEL) return [];
	try {
		const parsed = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return parsed
			.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
			.map((item) => item.trim());
	} catch {
		return [];
	}
}

function normalizeToolName(value: string): string {
	return value.trim().replace(/-/g, "_");
}

function addDenyCandidate(candidates: Set<string>, value: string): void {
	const trimmed = value.trim();
	if (!trimmed) return;
	candidates.add(trimmed);
	candidates.add(normalizeToolName(trimmed));
}

function buildDenyMatcher(denyTools: string[]): (toolName: string) => boolean {
	const exact = new Set<string>();
	const prefixes = new Set<string>();

	for (const raw of denyTools) {
		const item = raw.trim();
		if (!item) continue;
		addDenyCandidate(exact, item);

		const mcpSpec = item.startsWith("mcp:") ? item.slice(4).trim() : item;
		if (mcpSpec !== item) addDenyCandidate(exact, mcpSpec);

		if (mcpSpec.includes("/")) {
			const [server, tool] = mcpSpec.split("/", 2);
			if (server && tool) {
				addDenyCandidate(exact, `${server}_${tool}`);
				const shortServer = server.replace(/-?mcp$/i, "");
				if (shortServer && shortServer !== server) addDenyCandidate(exact, `${shortServer}_${tool}`);
				addDenyCandidate(exact, tool);
			}
		} else if (item.startsWith("mcp:")) {
			const serverPrefix = normalizeToolName(mcpSpec);
			if (serverPrefix) {
				prefixes.add(`${serverPrefix}_`);
				const shortPrefix = normalizeToolName(mcpSpec.replace(/-?mcp$/i, ""));
				if (shortPrefix && shortPrefix !== serverPrefix) prefixes.add(`${shortPrefix}_`);
			}
		}
	}

	return (toolName: string) => {
		const normalized = normalizeToolName(toolName);
		if (exact.has(toolName) || exact.has(normalized)) return true;
		for (const prefix of prefixes) {
			if (normalized.startsWith(prefix)) return true;
		}
		return false;
	};
}

export function filterDeniedTools(activeTools: string[], denyTools: string[]): string[] {
	if (denyTools.length === 0 || activeTools.length === 0) return activeTools;
	const isDenied = buildDenyMatcher(denyTools);
	return activeTools.filter((tool) => !isDenied(tool));
}

function applyDeniedTools(pi: ExtensionAPI): boolean {
	const denyTools = parseCsvEnv(SUBAGENT_DENY_TOOLS_ENV);
	if (denyTools.length === 0) return false;
	if (typeof pi.getActiveTools !== "function" || typeof pi.setActiveTools !== "function") return false;
	const activeTools = pi.getActiveTools();
	const filtered = filterDeniedTools(activeTools, denyTools);
	if (filtered.length === activeTools.length && filtered.every((tool, index) => tool === activeTools[index])) return false;
	pi.setActiveTools(filtered);
	return true;
}

function findSectionEnd(prompt: string, startIndex: number, nextHeaders: string[]): number {
	let endIndex = prompt.length;
	for (const header of nextHeaders) {
		const index = prompt.indexOf(header, startIndex);
		if (index !== -1 && index < endIndex) {
			endIndex = index;
		}
	}
	return endIndex;
}

export function stripProjectContext(prompt: string): string {
	const startIndex = prompt.indexOf(PROJECT_CONTEXT_HEADER);
	if (startIndex === -1) return prompt;
	const endIndex = findSectionEnd(prompt, startIndex + PROJECT_CONTEXT_HEADER.length, [SKILLS_HEADER, DATE_HEADER]);
	return `${prompt.slice(0, startIndex)}${prompt.slice(endIndex)}`;
}

export function stripInheritedSkills(prompt: string): string {
	const startIndex = prompt.indexOf(SKILLS_HEADER);
	if (startIndex === -1) return prompt;
	const endIndex = findSectionEnd(prompt, startIndex + SKILLS_HEADER.length, [DATE_HEADER]);
	return `${prompt.slice(0, startIndex)}${prompt.slice(endIndex)}`;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeSkillName(value: string): string {
	return value.trim().toLowerCase();
}

function readNestedDelegationSkillNames(): string[] {
	const raw = process.env[SUBAGENT_NESTED_DELEGATION_SKILLS_ENV];
	if (raw === undefined) return [...DEFAULT_NESTED_DELEGATION_SKILLS];
	return parseJsonStringArrayEnv(SUBAGENT_NESTED_DELEGATION_SKILLS_ENV);
}

export function stripNestedDelegationSkills(prompt: string, skillNames: string[]): string {
	const names = [...new Set(skillNames.map(normalizeSkillName).filter(Boolean))];
	if (names.length === 0) return prompt;
	const namePattern = names.map(escapeRegExp).join("|");
	const explicitSkillPattern = new RegExp(`\\n{0,2}<skill\\s+name=["'](${namePattern})["'][^>]*>[\\s\\S]*?<\\/skill>\\n{0,2}`, "gi");
	const namedSkillPattern = new RegExp(`<name>\\s*(${namePattern})\\s*<\\/name>`, "i");
	return prompt
		.replace(explicitSkillPattern, "\n\n")
		.replace(/[ \t]*<skill>\s*[\s\S]*?<\/skill>\s*/g, (block) => namedSkillPattern.test(block) ? "" : block);
}

export function stripSubagentOrchestrationSkill(prompt: string): string {
	return stripNestedDelegationSkills(prompt, ["pi-subagents"]);
}

function hasSubagentDepthRemaining(): boolean {
	const depth = Number(process.env.PI_SUBAGENT_DEPTH ?? "0");
	const maxDepth = Number(process.env.PI_SUBAGENT_MAX_DEPTH ?? "0");
	return Number.isFinite(depth) && Number.isFinite(maxDepth) && depth < maxDepth;
}

function activeToolsAllowNestedSubagents(pi: ExtensionAPI): boolean {
	if (typeof pi.getActiveTools !== "function") return false;
	const activeTools = filterDeniedTools(pi.getActiveTools(), parseCsvEnv(SUBAGENT_DENY_TOOLS_ENV));
	return activeTools.some((tool) => normalizeToolName(tool) === SUBAGENT_TOOL_NAME);
}

function nestedSubagentDelegationAllowed(pi: ExtensionAPI): boolean {
	return hasSubagentDepthRemaining() && activeToolsAllowNestedSubagents(pi);
}

function readSkillNameFromPath(skillPath: string): string | undefined {
	const filePath = path.basename(skillPath).toLowerCase() === "skill.md"
		? skillPath
		: fs.existsSync(path.join(skillPath, "SKILL.md"))
			? path.join(skillPath, "SKILL.md")
			: skillPath;
	try {
		const content = fs.readFileSync(filePath, "utf-8").replace(/\r\n/g, "\n");
		if (content.startsWith("---")) {
			const endIndex = content.indexOf("\n---", 3);
			if (endIndex !== -1) {
				const frontmatter = content.slice(3, endIndex).trim();
				const match = frontmatter.match(/^name:\s*(.+)$/m);
				const name = match?.[1]?.trim().replace(/^['\"]|['\"]$/g, "");
				if (name) return name;
			}
		}
	} catch {
		// Fall back to path-derived names for compatibility with explicit custom paths.
	}
	const baseName = path.basename(skillPath);
	return baseName.toLowerCase() === "skill.md"
		? path.basename(path.dirname(skillPath))
		: path.basename(skillPath, path.extname(skillPath));
}

export function filterNestedDelegationSkillPaths(skillPaths: string[], skillNames: string[]): string[] {
	const names = new Set(skillNames.map(normalizeSkillName).filter(Boolean));
	if (names.size === 0) return skillPaths;
	return skillPaths.filter((skillPath) => {
		const name = readSkillNameFromPath(skillPath);
		return !name || !names.has(normalizeSkillName(name));
	});
}

function stripExistingBoundary(prompt: string): string {
	for (const boundary of [CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS, CHILD_SUBAGENT_NESTED_DELEGATION_INSTRUCTIONS]) {
		if (prompt.startsWith(`${boundary}\n\n`)) return prompt.slice(boundary.length + 2);
		if (prompt === boundary) return "";
	}
	return prompt;
}

export function rewriteSubagentPrompt(
	prompt: string,
	options: { inheritProjectContext: boolean; inheritSkills: boolean; allowNestedSubagents?: boolean },
): string {
	let rewritten = stripExistingBoundary(prompt);
	if (!options.inheritProjectContext) {
		rewritten = stripProjectContext(rewritten);
	}
	if (!options.inheritSkills) {
		rewritten = stripInheritedSkills(rewritten);
	}
	if (!options.allowNestedSubagents) {
		rewritten = stripNestedDelegationSkills(rewritten, readNestedDelegationSkillNames());
	}
	const boundary = options.allowNestedSubagents
		? CHILD_SUBAGENT_NESTED_DELEGATION_INSTRUCTIONS
		: CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS;
	return `${boundary}\n\n${rewritten}`;
}

function isParentOnlySubagentMessage(message: unknown): boolean {
	const m = message as { role?: string; customType?: string };
	return m?.role === "custom"
		&& typeof m.customType === "string"
		&& PARENT_ONLY_CUSTOM_MESSAGE_TYPES.has(m.customType);
}

function isSubagentToolResultMessage(message: unknown): boolean {
	const m = message as { role?: string; toolName?: string };
	return m?.role === "toolResult" && m.toolName === "subagent";
}

function isSubagentToolCallBlock(block: unknown): boolean {
	const b = block as { type?: string; name?: string };
	return b?.type === "toolCall" && b.name === "subagent";
}

function stripAssistantSubagentToolCallBlocks(message: unknown): unknown | undefined {
	const m = message as { role?: string; content?: unknown };
	if (m?.role !== "assistant" || !Array.isArray(m.content)) return message;
	const filteredContent = m.content.filter((block) => !isSubagentToolCallBlock(block));
	if (filteredContent.length === m.content.length) return message;
	if (filteredContent.length === 0) return undefined;
	return { ...m, content: filteredContent };
}

export function stripParentOnlySubagentMessages(
	messages: unknown[],
	options: { stripSubagentToolMessages?: boolean } = {},
): unknown[] {
	const stripSubagentToolMessages = options.stripSubagentToolMessages ?? true;
	let changed = false;
	const filtered: unknown[] = [];
	for (const message of messages) {
		if (isParentOnlySubagentMessage(message) || (stripSubagentToolMessages && isSubagentToolResultMessage(message))) {
			changed = true;
			continue;
		}
		const stripped = stripSubagentToolMessages ? stripAssistantSubagentToolCallBlocks(message) : message;
		if (stripped === undefined) {
			changed = true;
			continue;
		}
		if (stripped !== message) changed = true;
		filtered.push(stripped);
	}
	return changed ? filtered : messages;
}

export default function registerSubagentPromptRuntime(pi: ExtensionAPI): void {
	pi.on("resources_discover", () => {
		const skillPaths = parseJsonStringArrayEnv(SUBAGENT_SKILL_PATHS_ENV);
		const visibleSkillPaths = nestedSubagentDelegationAllowed(pi)
			? skillPaths
			: filterNestedDelegationSkillPaths(skillPaths, readNestedDelegationSkillNames());
		return visibleSkillPaths.length > 0 ? { skillPaths: visibleSkillPaths } : undefined;
	});

	pi.on("session_start", () => {
		applyDeniedTools(pi);
	});

	pi.on("context", (event) => {
		const messages = stripParentOnlySubagentMessages(event.messages, {
			stripSubagentToolMessages: !nestedSubagentDelegationAllowed(pi),
		});
		if (messages === event.messages) return undefined;
		return { messages };
	});

	pi.on("before_agent_start", async (event) => {
		const intercomSessionName = process.env[SUBAGENT_INTERCOM_SESSION_NAME_ENV]?.trim();
		if (intercomSessionName && typeof pi.setSessionName === "function") {
			pi.setSessionName(intercomSessionName);
		}

		const inheritProjectContext = readBooleanEnv(SUBAGENT_INHERIT_PROJECT_CONTEXT_ENV);
		const inheritSkills = readBooleanEnv(SUBAGENT_INHERIT_SKILLS_ENV);
		if (inheritProjectContext === undefined && inheritSkills === undefined) return;
		const rewritten = rewriteSubagentPrompt(event.systemPrompt, {
			inheritProjectContext: inheritProjectContext ?? true,
			inheritSkills: inheritSkills ?? true,
			allowNestedSubagents: nestedSubagentDelegationAllowed(pi),
		});
		if (rewritten === event.systemPrompt) return;
		return { systemPrompt: rewritten };
	});
}
