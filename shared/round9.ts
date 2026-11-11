// Round 9 contract (integrator-owned): lightweight projects + read-only sharing, conversation menu actions, global search, onboarding.
// Design: docs/research/r9-projects-audit.md (design A). A conversation NEVER moves between spaces (pi-durable storage is per space):
// project membership is a catalog relation. Legacy projects (kind "space", with their own space) keep working unchanged.

// ───────────── projects ─────────────
export type ProjectKind = "container" | "space";
/** What the caller may do with the project. "member" = legacy space project member (role-based, unchanged). */
export type ProjectAccess = "owner" | "member" | "shared_read";

export interface ProjectDTO {
	readonly id: string;
	readonly name: string;
	/** "container": groups conversations that live in their owners' personal spaces (new default). "space": legacy project with its own space. */
	readonly kind: ProjectKind;
	/** Legacy projects only. */
	readonly spaceId?: string;
	readonly ownerId: string;
	readonly ownerName?: string;
	readonly access: ProjectAccess;
	/** True when the project is shared with at least one other user (owner view) — or when the caller sees it through a share. */
	readonly shared: boolean;
	readonly conversationCount: number;
	readonly createdAt: string;
	readonly updatedAt: string;
}

/** A read grant on a container project (owner manages). Same organisation only. */
export interface ProjectShareDTO {
	readonly userId: string;
	readonly name: string;
	readonly email: string;
	/** Round 9: read only — view the project's conversations (messages, results, deliverables produced in them). No sending, no approvals. */
	readonly permission: "read";
	readonly grantedBy: string;
	readonly grantedAt: string;
}

/** Same-organisation people the caller may pick when sharing (GET /api/directory?q=). Never other orgs. */
export interface DirectoryUserDTO {
	readonly userId: string;
	readonly name: string;
	readonly email: string;
}

// Endpoints (all /api, session auth):
//   GET    /projects                          → { projects: ProjectDTO[] }   (own container projects, shared-with-me projects, legacy member projects)
//   POST   /projects { name }                 → { project }                  (creates a "container" project)
//   PATCH  /projects/:id { name }             → { project }                  (owner; legacy: project.manage)
//   DELETE /projects/:id                      → { ok, detached: number }     (container: only the relation is removed — conversations go back to "no project", nothing deleted; legacy: 409 unless empty)
//   GET    /projects/:id/shares               → { shares: ProjectShareDTO[] } (owner)
//   PUT    /projects/:id/shares/:userId { permission: "read" } → { share }  (owner; same org; not self)
//   DELETE /projects/:id/shares/:userId       → { ok }                       (owner; effective immediately incl. open streams)
//   GET    /directory?q=                      → { users: DirectoryUserDTO[] } (same org, max 20)
//   PUT    /conversations/:spaceId/:id/project { projectId: string | null } → { conversation }  (conversation creator, own personal-space conversation, own container project)
//   POST   /conversations { …, projectId }    — with a container project id: created in the caller's personal space and attached to the project

// ───────────── conversation menu ─────────────
export interface ConversationMetaDTO {
	readonly spaceId: string;
	readonly conversationId: number;
	/** Per user. */
	readonly starred: boolean;
	/** Per conversation (set by users with write access), normalised: trimmed, ≤ 24 chars, ≤ 8 tags. */
	readonly tags: readonly string[];
}
//   GET    /conversation-meta                 → { items: ConversationMetaDTO[] } (for the caller's visible conversations)
//   PUT    /conversations/:spaceId/:id/star { starred: boolean }  (read access is enough: personal flag)
//   PUT    /conversations/:spaceId/:id/tags { tags: string[] }    (write access)
//   GET    /conversations/:spaceId/:id/export?format=md  → text/markdown attachment (read access; test directives hidden like displayText)
//   DELETE /conversations/:spaceId/:id        → { ok }  (creator or space admin; soft delete: hidden everywhere and every access returns 404; durable data retained on the server)
//   existing: PATCH title/archived, share links (/shares), fork.

// ───────────── search (Ctrl/Cmd+K) ─────────────
export interface SearchHitDTO {
	readonly spaceId: string;
	readonly conversationId: number;
	readonly title: string;
	readonly projectId?: string;
	readonly projectName?: string;
	readonly tags: readonly string[];
	readonly starred: boolean;
	/** Where the query matched (best first). */
	readonly matchedIn: readonly ("title" | "message" | "tag" | "project")[];
	/** Short plain-text excerpt around the first message match (test directives removed), or empty. */
	readonly snippet: string;
	/** Entry to scroll to for a message match. */
	readonly entryId?: number;
	readonly updatedAt: string;
	/** "shared" when visible through a project share. */
	readonly access: "own" | "member" | "shared";
}
//   GET /search?q=&limit=20  → { results: SearchHitDTO[], indexedThrough?: string }  (only conversations the caller may read; deleted excluded)
//   GET /search/preview/:spaceId/:conversationId?entryId= → { title, turns: { role: "user"|"assistant", text: string, entryId: number }[] } (≤ 6 turns around the hit)

// ───────────── onboarding ─────────────
//   GET  /me → { …existing, onboarded: boolean }
//   POST /me/onboarding/complete { skipped?: string[] } → { onboarded: true }   (idempotent; per user, server-side)
