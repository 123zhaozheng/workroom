// Round 14: the tools and extensions the unified file/exec tools replace. They stay INSTALLED (so tasks persisted by older conversations still
// resolve their tool and finish, and old conversations keep working), but a NEW conversation no longer enables them: its agent removes these
// extensions (tools + their prompt sections) and tools. Task kinds and tool names are never renamed.
export const LEGACY_EXTENSIONS = ["wr.sandbox", "wr.files", "wr.localexec"] as const;
export const LEGACY_TOOLS = ["memory_save", "skill", "skill_list", "skill_load", "skill_run", "skill_read"] as const;

/** An assistant allowlist written before round 14 may name a replaced tool: it means the new equivalent. */
export const LEGACY_TOOL_MAP: Readonly<Record<string, readonly string[]>> = {
	sandbox_exec: ["exec"],
	code_run: ["exec"],
	sandbox_read_file: ["read", "ls"],
	sandbox_list: ["ls"],
	sandbox_write_file: ["write", "edit"],
	sandbox_import: ["copy_to_work"],
	sandbox_publish: ["present_file"],
	file_read: ["read", "ls"],
	file_list: ["ls", "search"],
	file_create: ["write", "present_file"],
	file_revise: ["write", "edit", "present_file"],
	memory_save: ["write", "edit", "read"],
	skill: ["read", "ls"],
	skill_list: ["ls"],
	skill_load: ["read"],
	skill_read: ["read"],
	skill_run: ["copy_to_work", "exec"],
};
