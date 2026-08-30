import { pgSchema, pgPolicy, uuid, text, jsonb, timestamp, index, foreignKey, integer, bigint, primaryKey, uniqueIndex } from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm"

export const appPrivate = pgSchema("app_private");


export const externalGameIdentitiesInAppPrivate = appPrivate.table("external_game_identities", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	provider: text().notNull(),
	sourceId: text("source_id").notNull(),
	medium: text().notNull(),
	snapshot: jsonb().notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	uniqueIndex("external_game_identities_provider_source_id_uidx").on(table.provider, table.sourceId),
	pgPolicy("runtime_external_identity", { as: "permissive", for: "all", to: ["app_runtime"], using: sql`true`, withCheck: sql`true`  }),
]);

export const gamesInAppPrivate = appPrivate.table("games", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	medium: text().notNull(),
	displayName: text("display_name").notNull(),
	externalGameIdentityId: uuid("external_game_identity_id").unique(),
	trashedAt: timestamp("trashed_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("games_display_name_idx").using("btree", table.displayName.asc().nullsLast().op("text_ops")).where(sql`(trashed_at IS NULL)`),
	foreignKey({
			columns: [table.externalGameIdentityId],
			foreignColumns: [externalGameIdentitiesInAppPrivate.id],
			name: "games_external_game_identity_id_fkey"
		}),
	pgPolicy("runtime_games", { as: "permissive", for: "all", to: ["app_runtime"], using: sql`true`, withCheck: sql`true`  }),
]);

export const gameNamesInAppPrivate = appPrivate.table("game_names", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	gameId: uuid("game_id").notNull(),
	name: text().notNull(),
	nameKind: text("name_kind").notNull(),
}, (table) => [
	uniqueIndex("game_names_game_name_kind_uidx").on(table.gameId, table.name, table.nameKind),
	foreignKey({
			columns: [table.gameId],
			foreignColumns: [gamesInAppPrivate.id],
			name: "game_names_game_id_fkey"
		}).onDelete("cascade"),
	pgPolicy("runtime_game_names", { as: "permissive", for: "all", to: ["app_runtime"], using: sql`true`, withCheck: sql`true`  }),
]);

export const sourceCategoriesInAppPrivate = appPrivate.table("source_categories", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	provider: text().notNull(),
	categoryKind: text("category_kind").notNull(),
	sourceCategoryId: text("source_category_id").notNull(),
	name: text().notNull(),
}, (table) => [
	uniqueIndex("source_categories_provider_kind_source_id_uidx").on(table.provider, table.categoryKind, table.sourceCategoryId),
	pgPolicy("runtime_source_categories", { as: "permissive", for: "all", to: ["app_runtime"], using: sql`true`, withCheck: sql`true`  }),
]);

export const externalGameCategoriesInAppPrivate = appPrivate.table("external_game_categories", {
	identityId: uuid("identity_id").notNull(),
	categoryId: uuid("category_id").notNull(),
}, (table) => [
	primaryKey({ columns: [table.identityId, table.categoryId] }),
	foreignKey({
			columns: [table.identityId],
			foreignColumns: [externalGameIdentitiesInAppPrivate.id],
			name: "external_game_categories_identity_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.categoryId],
			foreignColumns: [sourceCategoriesInAppPrivate.id],
			name: "external_game_categories_category_id_fkey"
		}).onDelete("restrict"),
	pgPolicy("runtime_external_game_categories", { as: "permissive", for: "all", to: ["app_runtime"], using: sql`true`, withCheck: sql`true`  }),
]);

export const sourceContributionsInAppPrivate = appPrivate.table("source_contributions", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	identityId: uuid("identity_id").notNull(),
	sourceContributorId: text("source_contributor_id").notNull(),
	name: text().notNull(),
	entityKind: text("entity_kind").notNull(),
	role: text().notNull(),
}, (table) => [
	uniqueIndex("source_contributions_identity_contributor_role_uidx").on(table.identityId, table.sourceContributorId, table.role),
	index("source_contributions_identity_id_idx").on(table.identityId),
	foreignKey({
			columns: [table.identityId],
			foreignColumns: [externalGameIdentitiesInAppPrivate.id],
			name: "source_contributions_identity_id_fkey"
		}).onDelete("cascade"),
	pgPolicy("runtime_source_contributions", { as: "permissive", for: "all", to: ["app_runtime"], using: sql`true`, withCheck: sql`true`  }),
]);

export const externalPlayerProfilesInAppPrivate = appPrivate.table("external_player_profiles", {
	identityId: uuid("identity_id").primaryKey().notNull(),
	minPlayers: integer("min_players"),
	maxPlayers: integer("max_players"),
	supportsSolo: text("supports_solo").notNull(),
}, (table) => [
	foreignKey({
			columns: [table.identityId],
			foreignColumns: [externalGameIdentitiesInAppPrivate.id],
			name: "external_player_profiles_identity_id_fkey"
		}).onDelete("cascade"),
	pgPolicy("runtime_external_player_profiles", { as: "permissive", for: "all", to: ["app_runtime"], using: sql`true`, withCheck: sql`true`  }),
]);

export const mediaIngestsInAppPrivate = appPrivate.table("media_ingests", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	gameId: uuid("game_id").notNull(),
	sourceUrl: text("source_url").notNull(),
	objectKey: text("object_key").notNull().unique(),
	originalState: text("original_state").notNull(),
	thumbnailState: text("thumbnail_state").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("media_ingests_game_id_idx").on(table.gameId),
	foreignKey({
			columns: [table.gameId],
			foreignColumns: [gamesInAppPrivate.id],
			name: "media_ingests_game_id_fkey"
		}).onDelete("cascade"),
	pgPolicy("runtime_media_ingests", { as: "permissive", for: "all", to: ["app_runtime"], using: sql`true`, withCheck: sql`true`  }),
]);

export const mediaAssetsInAppPrivate = appPrivate.table("media_assets", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	ingestId: uuid("ingest_id").notNull().unique(),
	kind: text().notNull(),
	objectKey: text("object_key").notNull().unique(),
	mimeType: text("mime_type").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	byteSize: bigint("byte_size", { mode: "number" }).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.ingestId],
			foreignColumns: [mediaIngestsInAppPrivate.id],
			name: "media_assets_ingest_id_fkey"
		}).onDelete("cascade"),
	pgPolicy("runtime_media_assets", { as: "permissive", for: "all", to: ["app_runtime"], using: sql`true`, withCheck: sql`true`  }),
]);

export const mediaDerivativesInAppPrivate = appPrivate.table("media_derivatives", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	assetId: uuid("asset_id").notNull(),
	kind: text().notNull(),
	objectKey: text("object_key").notNull().unique(),
	state: text().notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	uniqueIndex("media_derivatives_asset_kind_uidx").on(table.assetId, table.kind),
	index("media_derivatives_asset_id_idx").on(table.assetId),
	foreignKey({
			columns: [table.assetId],
			foreignColumns: [mediaAssetsInAppPrivate.id],
			name: "media_derivatives_asset_id_fkey"
		}).onDelete("cascade"),
	pgPolicy("runtime_media_derivatives", { as: "permissive", for: "all", to: ["app_runtime"], using: sql`true`, withCheck: sql`true`  }),
]);
