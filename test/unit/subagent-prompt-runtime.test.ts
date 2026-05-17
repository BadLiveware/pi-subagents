import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import registerSubagentPromptRuntime, {
	CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS,
	CHILD_SUBAGENT_NESTED_DELEGATION_INSTRUCTIONS,
	SUBAGENT_INTERCOM_SESSION_NAME_ENV,
	filterDeniedTools,
	rewriteSubagentPrompt,
	stripInheritedSkills,
	stripParentOnlySubagentMessages,
	stripProjectContext,
	stripSubagentOrchestrationSkill,
} from "../../src/runs/shared/subagent-prompt-runtime.ts";
import { SUBAGENT_DENY_TOOLS_ENV, SUBAGENT_SKILL_PATHS_ENV } from "../../src/runs/shared/pi-args.ts";

const envSnapshot = {
	PI_SUBAGENT_INHERIT_PROJECT_CONTEXT: process.env.PI_SUBAGENT_INHERIT_PROJECT_CONTEXT,
	PI_SUBAGENT_INHERIT_SKILLS: process.env.PI_SUBAGENT_INHERIT_SKILLS,
	PI_SUBAGENT_INTERCOM_SESSION_NAME: process.env.PI_SUBAGENT_INTERCOM_SESSION_NAME,
	PI_SUBAGENT_DENY_TOOLS: process.env.PI_SUBAGENT_DENY_TOOLS,
	PI_SUBAGENT_SKILL_PATHS: process.env.PI_SUBAGENT_SKILL_PATHS,
	PI_SUBAGENT_DEPTH: process.env.PI_SUBAGENT_DEPTH,
	PI_SUBAGENT_MAX_DEPTH: process.env.PI_SUBAGENT_MAX_DEPTH,
};

const SKILLS_SECTION = "\n\nThe following skills provide specialized instructions for specific tasks.\nUse the read tool to load a skill's file when the task matches its description.\nWhen a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.\n\n<available_skills>\n  <skill>\n    <name>safe-bash</name>\n    <description>desc</description>\n    <location>/tmp/SKILL.md</location>\n  </skill>\n  <skill>\n    <name>pi-subagents</name>\n    <description>delegate to subagents</description>\n    <location>/tmp/pi-subagents/SKILL.md</location>\n  </skill>\n</available_skills>";

const BASE_PROMPT = [
	"You are a subagent.",
	"\n\n# Project Context\n\nProject-specific instructions and guidelines:\n\n## /repo/AGENTS.md\n\nProject rules\n\n",
	SKILLS_SECTION,
	"\nCurrent date: 2026-04-16",
	"\nCurrent working directory: /repo",
].join("");

const PROMPT_WITH_EXPLICIT_SKILL = [
	"You are a subagent.\n\n<skill name=\"explicit\">\nKeep this section\n</skill>",
	"\n\n# Project Context\n\nProject-specific instructions and guidelines:\n\n## /repo/AGENTS.md\n\nProject rules\n\n",
	SKILLS_SECTION,
	"\nCurrent date: 2026-04-16",
].join("");

afterEach(() => {
	if (envSnapshot.PI_SUBAGENT_INHERIT_PROJECT_CONTEXT === undefined) delete process.env.PI_SUBAGENT_INHERIT_PROJECT_CONTEXT;
	else process.env.PI_SUBAGENT_INHERIT_PROJECT_CONTEXT = envSnapshot.PI_SUBAGENT_INHERIT_PROJECT_CONTEXT;
	if (envSnapshot.PI_SUBAGENT_INHERIT_SKILLS === undefined) delete process.env.PI_SUBAGENT_INHERIT_SKILLS;
	else process.env.PI_SUBAGENT_INHERIT_SKILLS = envSnapshot.PI_SUBAGENT_INHERIT_SKILLS;
	if (envSnapshot.PI_SUBAGENT_INTERCOM_SESSION_NAME === undefined) delete process.env.PI_SUBAGENT_INTERCOM_SESSION_NAME;
	else process.env.PI_SUBAGENT_INTERCOM_SESSION_NAME = envSnapshot.PI_SUBAGENT_INTERCOM_SESSION_NAME;
	if (envSnapshot.PI_SUBAGENT_DENY_TOOLS === undefined) delete process.env.PI_SUBAGENT_DENY_TOOLS;
	else process.env.PI_SUBAGENT_DENY_TOOLS = envSnapshot.PI_SUBAGENT_DENY_TOOLS;
	if (envSnapshot.PI_SUBAGENT_SKILL_PATHS === undefined) delete process.env.PI_SUBAGENT_SKILL_PATHS;
	else process.env.PI_SUBAGENT_SKILL_PATHS = envSnapshot.PI_SUBAGENT_SKILL_PATHS;
	if (envSnapshot.PI_SUBAGENT_DEPTH === undefined) delete process.env.PI_SUBAGENT_DEPTH;
	else process.env.PI_SUBAGENT_DEPTH = envSnapshot.PI_SUBAGENT_DEPTH;
	if (envSnapshot.PI_SUBAGENT_MAX_DEPTH === undefined) delete process.env.PI_SUBAGENT_MAX_DEPTH;
	else process.env.PI_SUBAGENT_MAX_DEPTH = envSnapshot.PI_SUBAGENT_MAX_DEPTH;
});

describe("subagent prompt runtime", () => {
	it("filters denied builtin and MCP direct tools", () => {
		assert.deepEqual(
			filterDeniedTools(
				["read", "bash", "subagent", "github_create_pull_request", "chrome_devtools_list_pages"],
				["subagent", "mcp:github/create_pull_request", "mcp:chrome-devtools"],
			),
			["read", "bash"],
		);
	});

	it("applies denied tools during session startup", () => {
		let sessionStart: (() => void) | undefined;
		let activeTools = ["read", "bash", "subagent", "github_create_pull_request"];
		process.env[SUBAGENT_DENY_TOOLS_ENV] = "subagent,mcp:github/create_pull_request";

		registerSubagentPromptRuntime({
			on(event: string, handler: () => void) {
				if (event === "session_start") sessionStart = handler;
			},
			getActiveTools() {
				return activeTools;
			},
			setActiveTools(toolNames: string[]) {
				activeTools = toolNames;
			},
		} as { on(event: string, handler: () => void): void; getActiveTools(): string[]; setActiveTools(toolNames: string[]): void });

		sessionStart?.();

		assert.deepEqual(activeTools, ["read", "bash"]);
	});

	it("contributes explicit subagent skill paths through resource discovery", () => {
		let resourcesDiscover: (() => { skillPaths: string[] } | undefined) | undefined;
		process.env[SUBAGENT_SKILL_PATHS_ENV] = JSON.stringify(["/repo/.pi/skills/review/SKILL.md", "/tmp/custom-skill.md"]);

		registerSubagentPromptRuntime({
			on(event: string, handler: () => { skillPaths: string[] } | undefined) {
				if (event === "resources_discover") resourcesDiscover = handler;
			},
		} as { on(event: string, handler: () => { skillPaths: string[] } | undefined): void });

		assert.deepEqual(resourcesDiscover?.(), {
			skillPaths: ["/repo/.pi/skills/review/SKILL.md", "/tmp/custom-skill.md"],
		});
	});

	it("strips only the project context block", () => {
		const rewritten = stripProjectContext(BASE_PROMPT);
		assert.ok(!rewritten.includes("# Project Context"));
		assert.ok(rewritten.includes("The following skills provide specialized instructions for specific tasks."));
		assert.ok(rewritten.includes("Current date: 2026-04-16"));
	});

	it("strips only the inherited skills block", () => {
		const rewritten = stripInheritedSkills(BASE_PROMPT);
		assert.ok(rewritten.includes("# Project Context"));
		assert.ok(!rewritten.includes("<available_skills>"));
		assert.ok(rewritten.includes("Current date: 2026-04-16"));
	});

	it("can strip both inherited sections together", () => {
		const rewritten = rewriteSubagentPrompt(BASE_PROMPT, {
			inheritProjectContext: false,
			inheritSkills: false,
		});
		assert.ok(!rewritten.includes("# Project Context"));
		assert.ok(!rewritten.includes("<available_skills>"));
		assert.ok(rewritten.includes("Current working directory: /repo"));
	});

	it("injects a child-only boundary that forbids proposing or running subagents", () => {
		const rewritten = rewriteSubagentPrompt(BASE_PROMPT, {
			inheritProjectContext: true,
			inheritSkills: true,
		});

		assert.ok(rewritten.startsWith(CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS));
		assert.ok(rewritten.includes("Do not propose or run subagents."));
		assert.ok(rewritten.includes("If you need to edit files, call the actual edit/write tools."));
		assert.ok(rewritten.includes("Do not print tool-call syntax, patches, or pseudo-tool calls as text."));
		assert.equal(rewriteSubagentPrompt(rewritten, { inheritProjectContext: true, inheritSkills: true }).indexOf(CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS), 0);
		assert.equal(rewriteSubagentPrompt(rewritten, { inheritProjectContext: true, inheritSkills: true }).lastIndexOf(CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS), 0);
	});

	it("keeps explicitly injected skill content when inherited skills are stripped", () => {
		const rewritten = rewriteSubagentPrompt(PROMPT_WITH_EXPLICIT_SKILL, {
			inheritProjectContext: false,
			inheritSkills: false,
		});
		assert.ok(rewritten.includes("<skill name=\"explicit\">"));
		assert.ok(!rewritten.includes("<available_skills>"));
		assert.ok(!rewritten.includes("# Project Context"));
	});

	it("strips the subagent orchestration skill even when inherited skills remain", () => {
		const rewritten = rewriteSubagentPrompt(BASE_PROMPT, {
			inheritProjectContext: true,
			inheritSkills: true,
		});

		assert.ok(rewritten.includes("<name>safe-bash</name>"));
		assert.ok(!rewritten.includes("<name>pi-subagents</name>"));
		assert.ok(!rewritten.includes("delegate to subagents"));
	});

	it("keeps the subagent orchestration skill when nested delegation is allowed", () => {
		const rewritten = rewriteSubagentPrompt(BASE_PROMPT, {
			inheritProjectContext: true,
			inheritSkills: true,
			allowNestedSubagents: true,
		});

		assert.ok(rewritten.startsWith(CHILD_SUBAGENT_NESTED_DELEGATION_INSTRUCTIONS));
		assert.ok(rewritten.includes("Nested subagent delegation is allowed"));
		assert.ok(!rewritten.includes("Do not propose or run subagents."));
		assert.ok(rewritten.includes("<name>pi-subagents</name>"));
		assert.equal(rewriteSubagentPrompt(rewritten, { inheritProjectContext: true, inheritSkills: true, allowNestedSubagents: true }).indexOf(CHILD_SUBAGENT_NESTED_DELEGATION_INSTRUCTIONS), 0);
		assert.equal(rewriteSubagentPrompt(rewritten, { inheritProjectContext: true, inheritSkills: true, allowNestedSubagents: true }).lastIndexOf(CHILD_SUBAGENT_NESTED_DELEGATION_INSTRUCTIONS), 0);
	});

	it("strips explicit pi-subagents skill injection from child prompts", () => {
		const prompt = "Before\n\n<skill name=\"pi-subagents\">\nDo not keep this.\n</skill>\n\n<skill name=\"safe-bash\">\nKeep this.\n</skill>\nAfter";
		const rewritten = stripSubagentOrchestrationSkill(prompt);

		assert.ok(!rewritten.includes("Do not keep this"));
		assert.ok(rewritten.includes("<skill name=\"safe-bash\">"));
	});

	it("strips parent-only subagent custom messages from forked child context", () => {
		const user = { role: "user", content: "Task" };
		const instruction = { role: "custom", customType: "subagent-orchestration-instructions", content: "Subagent orchestration is enabled." };
		const slashResult = { role: "custom", customType: "subagent-slash-result", content: "## Orchestration" };
		const notify = { role: "custom", customType: "subagent-notify", content: "Background task completed" };
		const control = { role: "custom", customType: "subagent_control_notice", content: "needs attention" };
		const otherCustom = { role: "custom", customType: "other", content: "keep" };

		assert.deepEqual(stripParentOnlySubagentMessages([user, instruction, slashResult, notify, control, otherCustom]), [user, otherCustom]);
	});

	it("strips prior parent subagent tool calls and results from forked child context", () => {
		const user = { role: "user", content: "Task" };
		const subagentResult = { role: "toolResult", toolName: "subagent", content: "subagent results" };
		const readResult = { role: "toolResult", toolName: "read", content: "file contents" };
		const mixedAssistant = {
			role: "assistant",
			content: [
				{ type: "text", text: "I will inspect the repo." },
				{ type: "toolCall", name: "subagent", input: { agent: "worker" } },
				{ type: "toolCall", name: "read", input: { path: "README.md" } },
			],
		};
		const pureSubagentCall = {
			role: "assistant",
			content: [{ type: "toolCall", name: "subagent", input: { agent: "reviewer" } }],
		};

		assert.deepEqual(
			stripParentOnlySubagentMessages([user, subagentResult, readResult, mixedAssistant, pureSubagentCall]),
			[
				user,
				readResult,
				{
					role: "assistant",
					content: [
						{ type: "text", text: "I will inspect the repo." },
						{ type: "toolCall", name: "read", input: { path: "README.md" } },
					],
				},
			],
		);
	});

	it("keeps subagent tool messages when nested delegation is allowed", () => {
		const user = { role: "user", content: "Task" };
		const instruction = { role: "custom", customType: "subagent-orchestration-instructions", content: "parent-only" };
		const subagentResult = { role: "toolResult", toolName: "subagent", content: "nested result" };
		const subagentCall = { role: "assistant", content: [{ type: "toolCall", name: "subagent", input: { agent: "worker" } }] };

		assert.deepEqual(
			stripParentOnlySubagentMessages([user, instruction, subagentCall, subagentResult], { stripSubagentToolMessages: false }),
			[user, subagentCall, subagentResult],
		);
	});

	it("sets the child intercom session name from env during agent startup", async () => {
		let sessionName: string | undefined;
		let beforeAgentStart: ((event: { systemPrompt: string }) => Promise<{ systemPrompt: string } | undefined>) | undefined;
		process.env[SUBAGENT_INTERCOM_SESSION_NAME_ENV] = "subagent-worker-78f659a3";

		registerSubagentPromptRuntime({
			on(event: string, handler: (payload: { systemPrompt: string }) => Promise<{ systemPrompt: string } | undefined>) {
				if (event === "before_agent_start") beforeAgentStart = handler;
			},
			setSessionName(name: string) {
				sessionName = name;
			},
		} as { on(event: string, handler: (payload: { systemPrompt: string }) => Promise<{ systemPrompt: string } | undefined>): void; setSessionName(name: string): void });

		await beforeAgentStart?.({ systemPrompt: BASE_PROMPT });

		assert.equal(sessionName, "subagent-worker-78f659a3");
	});

	it("rewrites the final child-visible prompt through before_agent_start", async () => {
		let beforeAgentStart: ((event: { systemPrompt: string }) => Promise<{ systemPrompt: string } | undefined>) | undefined;
		registerSubagentPromptRuntime({
			on(event: string, handler: (payload: { systemPrompt: string }) => Promise<{ systemPrompt: string } | undefined>) {
				if (event === "before_agent_start") beforeAgentStart = handler;
			},
		} as { on(event: string, handler: (payload: { systemPrompt: string }) => Promise<{ systemPrompt: string } | undefined>): void });

		assert.ok(beforeAgentStart, "expected before_agent_start handler");
		process.env.PI_SUBAGENT_INHERIT_PROJECT_CONTEXT = "0";
		process.env.PI_SUBAGENT_INHERIT_SKILLS = "0";

		const rewritten = await beforeAgentStart?.({ systemPrompt: BASE_PROMPT });
		assert.ok(rewritten);
		assert.ok(!rewritten.systemPrompt.includes("# Project Context"));
		assert.ok(!rewritten.systemPrompt.includes("<available_skills>"));
		assert.ok(rewritten.systemPrompt.includes("Current date: 2026-04-16"));
	});

	it("preserves pi-subagents guidance during startup when tool and depth allow nested delegation", async () => {
		let beforeAgentStart: ((event: { systemPrompt: string }) => Promise<{ systemPrompt: string } | undefined>) | undefined;
		process.env.PI_SUBAGENT_INHERIT_PROJECT_CONTEXT = "1";
		process.env.PI_SUBAGENT_INHERIT_SKILLS = "1";
		process.env.PI_SUBAGENT_DEPTH = "1";
		process.env.PI_SUBAGENT_MAX_DEPTH = "2";
		process.env[SUBAGENT_DENY_TOOLS_ENV] = "__none__";

		registerSubagentPromptRuntime({
			on(event: string, handler: (payload: { systemPrompt: string }) => Promise<{ systemPrompt: string } | undefined>) {
				if (event === "before_agent_start") beforeAgentStart = handler;
			},
			getActiveTools() {
				return ["read", "subagent"];
			},
		} as { on(event: string, handler: (payload: { systemPrompt: string }) => Promise<{ systemPrompt: string } | undefined>): void; getActiveTools(): string[] });

		const rewritten = await beforeAgentStart?.({ systemPrompt: BASE_PROMPT });
		assert.ok(rewritten);
		assert.ok(rewritten.systemPrompt.startsWith(CHILD_SUBAGENT_NESTED_DELEGATION_INSTRUCTIONS));
		assert.ok(rewritten.systemPrompt.includes("<name>pi-subagents</name>"));
	});

	it("strips pi-subagents guidance during startup when nested delegation is denylisted", async () => {
		let beforeAgentStart: ((event: { systemPrompt: string }) => Promise<{ systemPrompt: string } | undefined>) | undefined;
		process.env.PI_SUBAGENT_INHERIT_PROJECT_CONTEXT = "1";
		process.env.PI_SUBAGENT_INHERIT_SKILLS = "1";
		process.env.PI_SUBAGENT_DEPTH = "1";
		process.env.PI_SUBAGENT_MAX_DEPTH = "2";
		process.env[SUBAGENT_DENY_TOOLS_ENV] = "subagent";

		registerSubagentPromptRuntime({
			on(event: string, handler: (payload: { systemPrompt: string }) => Promise<{ systemPrompt: string } | undefined>) {
				if (event === "before_agent_start") beforeAgentStart = handler;
			},
			getActiveTools() {
				return ["read", "subagent"];
			},
		} as { on(event: string, handler: (payload: { systemPrompt: string }) => Promise<{ systemPrompt: string } | undefined>): void; getActiveTools(): string[] });

		const rewritten = await beforeAgentStart?.({ systemPrompt: BASE_PROMPT });
		assert.ok(rewritten);
		assert.ok(rewritten.systemPrompt.startsWith(CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS));
		assert.ok(!rewritten.systemPrompt.includes("<name>pi-subagents</name>"));
	});

	it("filters parent-only artifacts from polluted fork context while preserving ordinary history", () => {
		let contextHandler: ((event: { messages: unknown[] }) => { messages: unknown[] } | undefined) | undefined;
		registerSubagentPromptRuntime({
			on(event: string, handler: (payload: { messages: unknown[] }) => { messages: unknown[] } | undefined) {
				if (event === "context") contextHandler = handler;
			},
		} as { on(event: string, handler: (payload: { messages: unknown[] }) => { messages: unknown[] } | undefined): void });

		const priorParentTurn = { role: "user", content: "Earlier we said planner → worker → reviewers → worker." };
		const currentTask = { role: "user", content: "Now implement only the assigned fix." };
		const instruction = { role: "custom", customType: "subagent-orchestration-instructions", content: "Subagent orchestration is enabled." };
		const slashResult = { role: "custom", customType: "subagent-slash-result", content: "## Orchestration" };
		const subagentResult = { role: "toolResult", toolName: "subagent", content: "subagent results" };
		const subagentCall = { role: "assistant", content: [{ type: "toolCall", name: "subagent", input: { agent: "worker" } }] };
		const otherCustom = { role: "custom", customType: "other", content: "keep" };

		assert.deepEqual(contextHandler?.({ messages: [priorParentTurn, instruction, slashResult, subagentCall, subagentResult, otherCustom, currentTask] }), {
			messages: [priorParentTurn, otherCustom, currentTask],
		});
	});

	it("preserves subagent tool context when runtime allows nested delegation", () => {
		let contextHandler: ((event: { messages: unknown[] }) => { messages: unknown[] } | undefined) | undefined;
		process.env.PI_SUBAGENT_DEPTH = "1";
		process.env.PI_SUBAGENT_MAX_DEPTH = "2";
		process.env[SUBAGENT_DENY_TOOLS_ENV] = "__none__";
		registerSubagentPromptRuntime({
			on(event: string, handler: (payload: { messages: unknown[] }) => { messages: unknown[] } | undefined) {
				if (event === "context") contextHandler = handler;
			},
			getActiveTools() {
				return ["read", "subagent"];
			},
		} as { on(event: string, handler: (payload: { messages: unknown[] }) => { messages: unknown[] } | undefined): void; getActiveTools(): string[] });

		const currentTask = { role: "user", content: "Synthesize nested work." };
		const instruction = { role: "custom", customType: "subagent-orchestration-instructions", content: "parent-only" };
		const subagentResult = { role: "toolResult", toolName: "subagent", content: "nested result" };
		const subagentCall = { role: "assistant", content: [{ type: "toolCall", name: "subagent", input: { agent: "worker" } }] };

		assert.deepEqual(contextHandler?.({ messages: [currentTask, instruction, subagentCall, subagentResult] }), {
			messages: [currentTask, subagentCall, subagentResult],
		});
	});

	it("does not rewrite child context when no parent-only artifacts are present", () => {
		let contextHandler: ((event: { messages: unknown[] }) => { messages: unknown[] } | undefined) | undefined;
		registerSubagentPromptRuntime({
			on(event: string, handler: (payload: { messages: unknown[] }) => { messages: unknown[] } | undefined) {
				if (event === "context") contextHandler = handler;
			},
		} as { on(event: string, handler: (payload: { messages: unknown[] }) => { messages: unknown[] } | undefined): void });

		const messages = [
			{ role: "user", content: "Task" },
			{ role: "toolResult", toolName: "read", content: "file" },
			{ role: "assistant", content: [{ type: "toolCall", name: "read", input: { path: "README.md" } }] },
		];

		assert.equal(contextHandler?.({ messages }), undefined);
	});
});
