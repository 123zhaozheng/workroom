// Front-end view of the HTTP API. Identity/project shapes mirror server/src/identity/module.ts.
// Domain DTOs for chat/files/knowledge/ops are owned by groups A/C/D/E in shared/*.ts; the
// feature folders adapt those into the view models used by components (see src/features/*/model.ts).

export type OrgRole = "owner" | "admin" | "member";
export type ProjectRole = "owner" | "editor" | "viewer";

export interface MeResponse {
	me: {
		userId: string;
		orgId: string;
		orgName?: string;
		orgRole: OrgRole;
		name: string;
		email: string;
		departmentIds?: string[];
		/** RBAC: permission ids held at org scope / at org scope or in any department or project scope. */
		permissions?: string[];
		permissionsAnywhere?: string[];
		baseRole?: string;
	};
	personalSpaceId: string;
	brand: { name: string; tagline: string };
}

export interface Project {
	id: string;
	name: string;
	description?: string;
	role: ProjectRole;
	spaceId: string;
	createdAt?: string;
}

export interface ProjectMember {
	id: string;
	name: string;
	email: string;
	role: ProjectRole;
}
