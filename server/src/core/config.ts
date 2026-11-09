import { resolve } from "node:path";
import { randomUUID } from "node:crypto";

export interface AppConfig {
	/** Root data volume. Everything durable lives below it: app.sqlite, blobs/, orgs/<org>/spaces/<space>/. */
	readonly dataDir: string;
	readonly port: number;
	readonly host: string;
	/** Identifies this process as a storage owner (single-owner lease). */
	readonly instanceId: string;
	readonly brand: { name: string; tagline: string };
	/** Serve built web assets from this directory when present. */
	readonly webDist: string;
	/** Secret used to encrypt credentials at rest (model keys, connector tokens). Server-side only. */
	readonly secretKey: string | undefined;
	readonly secureCookies: boolean;
	/** Enable the deterministic fixture model (for credential-free tests/demo; always labelled as fixture). */
	readonly fixtureModel: boolean;
}

export function loadConfig(overrides: Partial<AppConfig> = {}): AppConfig {
	const env = process.env;
	return {
		dataDir: resolve(env.WORKROOM_DATA_DIR ?? "data"),
		port: Number(env.PORT ?? 8787),
		host: env.HOST ?? "127.0.0.1",
		instanceId: env.WORKROOM_INSTANCE_ID ?? `wr-${process.pid}-${randomUUID().slice(0, 8)}`,
		brand: { name: env.WORKROOM_BRAND_NAME ?? "Workroom", tagline: env.WORKROOM_BRAND_TAGLINE ?? "把要完成的事交给我" },
		webDist: resolve(env.WORKROOM_WEB_DIST ?? "web/dist"),
		secretKey: env.WORKROOM_SECRET_KEY,
		secureCookies: env.WORKROOM_SECURE_COOKIES === "1",
		fixtureModel: env.WORKROOM_FIXTURE_MODEL !== "0",
		...overrides,
	};
}
