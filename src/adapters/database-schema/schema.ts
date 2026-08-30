import { pgTable, pgSchema, pgPolicy, uuid, text, jsonb, timestamp, uniqueIndex, foreignKey, index, integer, bigint, boolean, numeric } from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm"

export const appPrivate = pgSchema("app_private");


export const externalGameIdentitiesInAppPrivate = appPrivate.table("external_game_identities", {
	id: uuid().defaultRandom().notNull(),
	provider: text().notNull(),
	sourceId: text("source_id").notNull(),
	medium: text().notNull(),
	snapshot: jsonb().notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	pgPolicy("runtime_external_identity", { as: "permissive", for: "all", to: ["app_runtime"], using: sql`true`, withCheck: sql`true`  }),
]);

export const gameNamesInAppPrivate = appPrivate.table("game_names", {
	id: uuid().defaultRandom().notNull(),
	gameId: uuid("game_id").notNull(),
	name: text().notNull(),
	nameKind: text("name_kind").notNull(),
}, (table) => [
	uniqueIndex("game_names_custom_unique").using("btree", table.gameId.asc().nullsLast().op("uuid_ops"), table.nameKind.asc().nullsLast().op("uuid_ops")).where(sql`(name_kind = 'custom'::text)`),
	foreignKey({
			columns: [table.gameId],
			foreignColumns: [gamesInAppPrivate.id],
			name: "game_names_game_id_fkey"
		}).onDelete("cascade"),
	pgPolicy("runtime_game_names", { as: "permissive", for: "all", to: ["app_runtime"], using: sql`true`, withCheck: sql`true`  }),
]);

export const gamesInAppPrivate = appPrivate.table("games", {
	id: uuid().defaultRandom().notNull(),
	medium: text().notNull(),
	displayName: text("display_name").notNull(),
	externalGameIdentityId: uuid("external_game_identity_id"),
	trashedAt: timestamp("trashed_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	playerCountNote: text("player_count_note"),
}, (table) => [
	index("games_display_name_idx").using("btree", table.displayName.asc().nullsLast().op("text_ops")).where(sql`(trashed_at IS NULL)`),
	foreignKey({
			columns: [table.externalGameIdentityId],
			foreignColumns: [externalGameIdentitiesInAppPrivate.id],
			name: "games_external_game_identity_id_fkey"
		}),
	foreignKey({
			columns: [table.medium, table.externalGameIdentityId],
			foreignColumns: [externalGameIdentitiesInAppPrivate.id, externalGameIdentitiesInAppPrivate.medium],
			name: "games_external_identity_medium_fk"
		}),
	pgPolicy("runtime_games", { as: "permissive", for: "all", to: ["app_runtime"], using: sql`true`, withCheck: sql`true`  }),
]);

export const sourceCategoriesInAppPrivate = appPrivate.table("source_categories", {
	id: uuid().defaultRandom().notNull(),
	provider: text().notNull(),
	categoryKind: text("category_kind").notNull(),
	sourceCategoryId: text("source_category_id").notNull(),
	name: text().notNull(),
}, (table) => [
	pgPolicy("runtime_source_categories", { as: "permissive", for: "all", to: ["app_runtime"], using: sql`true`, withCheck: sql`true`  }),
]);

export const externalGameCategoriesInAppPrivate = appPrivate.table("external_game_categories", {
	identityId: uuid("identity_id").notNull(),
	categoryId: uuid("category_id").notNull(),
}, (table) => [
	index("external_game_categories_category_id_idx").using("btree", table.categoryId.asc().nullsLast().op("uuid_ops")),
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

export const externalPlayerProfilesInAppPrivate = appPrivate.table("external_player_profiles", {
	identityId: uuid("identity_id").notNull(),
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
	id: uuid().defaultRandom().notNull(),
	gameId: uuid("game_id").notNull(),
	sourceUrl: text("source_url").notNull(),
	objectKey: text("object_key").notNull(),
	originalState: text("original_state").notNull(),
	thumbnailState: text("thumbnail_state").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("media_ingests_game_id_idx").using("btree", table.gameId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.gameId],
			foreignColumns: [gamesInAppPrivate.id],
			name: "media_ingests_game_id_fkey"
		}).onDelete("cascade"),
	pgPolicy("runtime_media_ingests", { as: "permissive", for: "all", to: ["app_runtime"], using: sql`true`, withCheck: sql`true`  }),
]);

export const mediaAssetsInAppPrivate = appPrivate.table("media_assets", {
	id: uuid().defaultRandom().notNull(),
	ingestId: uuid("ingest_id").notNull(),
	kind: text().notNull(),
	objectKey: text("object_key").notNull(),
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
	id: uuid().defaultRandom().notNull(),
	assetId: uuid("asset_id").notNull(),
	kind: text().notNull(),
	objectKey: text("object_key").notNull(),
	state: text().notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("media_derivatives_asset_id_idx").using("btree", table.assetId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.assetId],
			foreignColumns: [mediaAssetsInAppPrivate.id],
			name: "media_derivatives_asset_id_fkey"
		}).onDelete("cascade"),
	pgPolicy("runtime_media_derivatives", { as: "permissive", for: "all", to: ["app_runtime"], using: sql`true`, withCheck: sql`true`  }),
]);

export const manualContributionsInAppPrivate = appPrivate.table("manual_contributions", {
	id: uuid().defaultRandom().notNull(),
	gameId: uuid("game_id").notNull(),
	contributorId: uuid("contributor_id").notNull(),
	role: text().notNull(),
}, (table) => [
	index("manual_contributions_contributor_id_idx").using("btree", table.contributorId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.gameId],
			foreignColumns: [gamesInAppPrivate.id],
			name: "manual_contributions_game_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.contributorId],
			foreignColumns: [contributorsInAppPrivate.id],
			name: "manual_contributions_contributor_id_fkey"
		}).onDelete("restrict"),
	pgPolicy("runtime_manual_contributions", { as: "permissive", for: "all", to: ["app_runtime"], using: sql`true`, withCheck: sql`true`  }),
]);

export const sourceContributionsInAppPrivate = appPrivate.table("source_contributions", {
	id: uuid().defaultRandom().notNull(),
	identityId: uuid("identity_id").notNull(),
	sourceContributorId: text("source_contributor_id").notNull(),
	name: text().notNull(),
	entityKind: text("entity_kind").notNull(),
	role: text().notNull(),
	contributorId: uuid("contributor_id").notNull(),
}, (table) => [
	index("source_contributions_identity_id_idx").using("btree", table.identityId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.identityId],
			foreignColumns: [externalGameIdentitiesInAppPrivate.id],
			name: "source_contributions_identity_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.contributorId],
			foreignColumns: [contributorsInAppPrivate.id],
			name: "source_contributions_contributor_id_fkey"
		}).onDelete("restrict"),
	pgPolicy("runtime_source_contributions", { as: "permissive", for: "all", to: ["app_runtime"], using: sql`true`, withCheck: sql`true`  }),
]);

export const platformsInAppPrivate = appPrivate.table("platforms", {
	id: uuid().defaultRandom().notNull(),
	name: text().notNull(),
	normalizedName: text("normalized_name").notNull(),
	isSystem: boolean("is_system").default(false).notNull(),
}, (table) => [
	pgPolicy("runtime_platforms", { as: "permissive", for: "all", to: ["app_runtime"], using: sql`true`, withCheck: sql`true`  }),
]);

export const gamePlatformsInAppPrivate = appPrivate.table("game_platforms", {
	gameId: uuid("game_id").notNull(),
	platformId: uuid("platform_id").notNull(),
}, (table) => [
	index("game_platforms_platform_id_idx").using("btree", table.platformId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.gameId],
			foreignColumns: [gamesInAppPrivate.id],
			name: "game_platforms_game_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.platformId],
			foreignColumns: [platformsInAppPrivate.id],
			name: "game_platforms_platform_id_fkey"
		}).onDelete("restrict"),
	pgPolicy("runtime_game_platforms", { as: "permissive", for: "all", to: ["app_runtime"], using: sql`true`, withCheck: sql`true`  }),
]);

export const tagsInAppPrivate = appPrivate.table("tags", {
	id: uuid().defaultRandom().notNull(),
	name: text().notNull(),
	normalizedName: text("normalized_name").notNull(),
}, (table) => [
	pgPolicy("runtime_tags", { as: "permissive", for: "all", to: ["app_runtime"], using: sql`true`, withCheck: sql`true`  }),
]);

export const gameTagsInAppPrivate = appPrivate.table("game_tags", {
	gameId: uuid("game_id").notNull(),
	tagId: uuid("tag_id").notNull(),
}, (table) => [
	index("game_tags_tag_id_idx").using("btree", table.tagId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.gameId],
			foreignColumns: [gamesInAppPrivate.id],
			name: "game_tags_game_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.tagId],
			foreignColumns: [tagsInAppPrivate.id],
			name: "game_tags_tag_id_fkey"
		}).onDelete("restrict"),
	pgPolicy("runtime_game_tags", { as: "permissive", for: "all", to: ["app_runtime"], using: sql`true`, withCheck: sql`true`  }),
]);

export const contributorsInAppPrivate = appPrivate.table("contributors", {
	id: uuid().defaultRandom().notNull(),
	name: text().notNull(),
	entityKind: text("entity_kind").notNull(),
	sourceProvider: text("source_provider"),
	sourceContributorId: text("source_contributor_id"),
}, (table) => [
	uniqueIndex("contributors_source_identity_unique").using("btree", table.sourceProvider.asc().nullsLast().op("text_ops"), table.sourceContributorId.asc().nullsLast().op("text_ops")).where(sql`(source_provider IS NOT NULL)`),
	pgPolicy("runtime_contributors", { as: "permissive", for: "all", to: ["app_runtime"], using: sql`true`, withCheck: sql`true`  }),
]);

export const externalSupportedPlatformsInAppPrivate = appPrivate.table("external_supported_platforms", {
	identityId: uuid("identity_id").notNull(),
	name: text().notNull(),
	normalizedName: text("normalized_name").notNull().generatedAlwaysAs(sql`lower(btrim(name))`),
}, (table) => [
	index("external_supported_platforms_name_idx").using("btree", table.normalizedName.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.identityId],
			foreignColumns: [externalGameIdentitiesInAppPrivate.id],
			name: "external_supported_platforms_identity_id_fkey"
		}).onDelete("cascade"),
	pgPolicy("runtime_external_supported_platforms", { as: "permissive", for: "all", to: ["app_runtime"], using: sql`true`, withCheck: sql`true`  }),
]);

export const bggCurrentMetricsInAppPrivate = appPrivate.table("bgg_current_metrics", {
	identityId: uuid("identity_id").notNull(),
	weight: numeric({ precision: 3, scale:  2 }),
	strategyRank: integer("strategy_rank"),
	lastSuccessfulSyncAt: timestamp("last_successful_sync_at", { withTimezone: true, mode: 'string' }),
}, (table) => [
	index("bgg_current_metrics_rank_idx").using("btree", table.strategyRank.asc().nullsLast().op("int4_ops")),
	index("bgg_current_metrics_weight_idx").using("btree", table.weight.asc().nullsLast().op("numeric_ops")),
	foreignKey({
			columns: [table.identityId],
			foreignColumns: [externalGameIdentitiesInAppPrivate.id],
			name: "bgg_current_metrics_identity_id_fkey"
		}).onDelete("cascade"),
	pgPolicy("runtime_bgg_current_metrics", { as: "permissive", for: "all", to: ["app_runtime"], using: sql`true`, withCheck: sql`true`  }),
]);
