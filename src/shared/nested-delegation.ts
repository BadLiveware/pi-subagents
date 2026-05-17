export const DEFAULT_NESTED_DELEGATION_SKILLS = ["pi-subagents"];

export function normalizeNestedDelegationSkills(value: unknown): string[] {
	if (value === false) return [];
	if (Array.isArray(value)) {
		return [...new Set(value
			.filter((item): item is string => typeof item === "string")
			.map((item) => item.trim())
			.filter(Boolean))];
	}
	if (typeof value === "string") {
		return [...new Set(value
			.split(",")
			.map((item) => item.trim())
			.filter(Boolean))];
	}
	return [...DEFAULT_NESTED_DELEGATION_SKILLS];
}
