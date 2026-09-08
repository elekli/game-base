import { relations } from "drizzle-orm/relations";
import { bggCurrentMetricsInAppPrivate, contributorsInAppPrivate, externalGameCategoriesInAppPrivate, externalGameIdentitiesInAppPrivate, externalPlayerProfilesInAppPrivate, externalSupportedPlatformsInAppPrivate, gameNamesInAppPrivate, gamePlatformsInAppPrivate, gamesInAppPrivate, gameTagsInAppPrivate, manualContributionsInAppPrivate, mediaAssetsInAppPrivate, mediaCleanupJobsInAppPrivate, mediaDerivativeAttemptsInAppPrivate, mediaDerivativesInAppPrivate, mediaIngestOperationsInAppPrivate, mediaIngestsInAppPrivate, notesInAppPrivate, platformsInAppPrivate, sourceCategoriesInAppPrivate, sourceContributionsInAppPrivate, sourceRefreshOperationsInAppPrivate, tagsInAppPrivate } from "./schema";

export const bggCurrentMetricsInAppPrivateRelations = relations(bggCurrentMetricsInAppPrivate, ({one}) => ({
	externalGameIdentitiesInAppPrivate: one(externalGameIdentitiesInAppPrivate, {
		fields: [bggCurrentMetricsInAppPrivate.identityId],
		references: [externalGameIdentitiesInAppPrivate.id]
	}),
}));

export const externalGameIdentitiesInAppPrivateRelations = relations(externalGameIdentitiesInAppPrivate, ({many}) => ({
	bggCurrentMetricsInAppPrivates: many(bggCurrentMetricsInAppPrivate),
	externalGameCategoriesInAppPrivates: many(externalGameCategoriesInAppPrivate),
	externalPlayerProfilesInAppPrivates: many(externalPlayerProfilesInAppPrivate),
	externalSupportedPlatformsInAppPrivates: many(externalSupportedPlatformsInAppPrivate),
	gamesInAppPrivates_externalGameIdentityId: many(gamesInAppPrivate, {
		relationName: "gamesInAppPrivate_externalGameIdentityId_externalGameIdentitiesInAppPrivate_id"
	}),
	gamesInAppPrivates_medium: many(gamesInAppPrivate, {
		relationName: "gamesInAppPrivate_medium_externalGameIdentitiesInAppPrivate_id"
	}),
	sourceContributionsInAppPrivates: many(sourceContributionsInAppPrivate),
	sourceRefreshOperationsInAppPrivates: many(sourceRefreshOperationsInAppPrivate),
}));

export const externalGameCategoriesInAppPrivateRelations = relations(externalGameCategoriesInAppPrivate, ({one}) => ({
	sourceCategoriesInAppPrivate: one(sourceCategoriesInAppPrivate, {
		fields: [externalGameCategoriesInAppPrivate.categoryId],
		references: [sourceCategoriesInAppPrivate.id]
	}),
	externalGameIdentitiesInAppPrivate: one(externalGameIdentitiesInAppPrivate, {
		fields: [externalGameCategoriesInAppPrivate.identityId],
		references: [externalGameIdentitiesInAppPrivate.id]
	}),
}));

export const sourceCategoriesInAppPrivateRelations = relations(sourceCategoriesInAppPrivate, ({many}) => ({
	externalGameCategoriesInAppPrivates: many(externalGameCategoriesInAppPrivate),
}));

export const externalPlayerProfilesInAppPrivateRelations = relations(externalPlayerProfilesInAppPrivate, ({one}) => ({
	externalGameIdentitiesInAppPrivate: one(externalGameIdentitiesInAppPrivate, {
		fields: [externalPlayerProfilesInAppPrivate.identityId],
		references: [externalGameIdentitiesInAppPrivate.id]
	}),
}));

export const externalSupportedPlatformsInAppPrivateRelations = relations(externalSupportedPlatformsInAppPrivate, ({one}) => ({
	externalGameIdentitiesInAppPrivate: one(externalGameIdentitiesInAppPrivate, {
		fields: [externalSupportedPlatformsInAppPrivate.identityId],
		references: [externalGameIdentitiesInAppPrivate.id]
	}),
}));

export const gameNamesInAppPrivateRelations = relations(gameNamesInAppPrivate, ({one}) => ({
	gamesInAppPrivate: one(gamesInAppPrivate, {
		fields: [gameNamesInAppPrivate.gameId],
		references: [gamesInAppPrivate.id]
	}),
}));

export const gamesInAppPrivateRelations = relations(gamesInAppPrivate, ({one, many}) => ({
	gameNamesInAppPrivates: many(gameNamesInAppPrivate),
	gamePlatformsInAppPrivates: many(gamePlatformsInAppPrivate),
	gameTagsInAppPrivates: many(gameTagsInAppPrivate),
	externalGameIdentitiesInAppPrivate_externalGameIdentityId: one(externalGameIdentitiesInAppPrivate, {
		fields: [gamesInAppPrivate.externalGameIdentityId],
		references: [externalGameIdentitiesInAppPrivate.id],
		relationName: "gamesInAppPrivate_externalGameIdentityId_externalGameIdentitiesInAppPrivate_id"
	}),
	externalGameIdentitiesInAppPrivate_medium: one(externalGameIdentitiesInAppPrivate, {
		fields: [gamesInAppPrivate.medium],
		references: [externalGameIdentitiesInAppPrivate.id],
		relationName: "gamesInAppPrivate_medium_externalGameIdentitiesInAppPrivate_id"
	}),
	manualContributionsInAppPrivates: many(manualContributionsInAppPrivate),
	mediaIngestOperationsInAppPrivates: many(mediaIngestOperationsInAppPrivate),
	mediaIngestsInAppPrivates: many(mediaIngestsInAppPrivate),
	notesInAppPrivates: many(notesInAppPrivate),
	sourceRefreshOperationsInAppPrivates: many(sourceRefreshOperationsInAppPrivate),
}));

export const gamePlatformsInAppPrivateRelations = relations(gamePlatformsInAppPrivate, ({one}) => ({
	gamesInAppPrivate: one(gamesInAppPrivate, {
		fields: [gamePlatformsInAppPrivate.gameId],
		references: [gamesInAppPrivate.id]
	}),
	platformsInAppPrivate: one(platformsInAppPrivate, {
		fields: [gamePlatformsInAppPrivate.platformId],
		references: [platformsInAppPrivate.id]
	}),
}));

export const platformsInAppPrivateRelations = relations(platformsInAppPrivate, ({many}) => ({
	gamePlatformsInAppPrivates: many(gamePlatformsInAppPrivate),
}));

export const gameTagsInAppPrivateRelations = relations(gameTagsInAppPrivate, ({one}) => ({
	gamesInAppPrivate: one(gamesInAppPrivate, {
		fields: [gameTagsInAppPrivate.gameId],
		references: [gamesInAppPrivate.id]
	}),
	tagsInAppPrivate: one(tagsInAppPrivate, {
		fields: [gameTagsInAppPrivate.tagId],
		references: [tagsInAppPrivate.id]
	}),
}));

export const tagsInAppPrivateRelations = relations(tagsInAppPrivate, ({many}) => ({
	gameTagsInAppPrivates: many(gameTagsInAppPrivate),
}));

export const manualContributionsInAppPrivateRelations = relations(manualContributionsInAppPrivate, ({one}) => ({
	contributorsInAppPrivate: one(contributorsInAppPrivate, {
		fields: [manualContributionsInAppPrivate.contributorId],
		references: [contributorsInAppPrivate.id]
	}),
	gamesInAppPrivate: one(gamesInAppPrivate, {
		fields: [manualContributionsInAppPrivate.gameId],
		references: [gamesInAppPrivate.id]
	}),
}));

export const contributorsInAppPrivateRelations = relations(contributorsInAppPrivate, ({many}) => ({
	manualContributionsInAppPrivates: many(manualContributionsInAppPrivate),
	sourceContributionsInAppPrivates: many(sourceContributionsInAppPrivate),
}));

export const mediaAssetsInAppPrivateRelations = relations(mediaAssetsInAppPrivate, ({one, many}) => ({
	mediaIngestsInAppPrivate: one(mediaIngestsInAppPrivate, {
		fields: [mediaAssetsInAppPrivate.ingestId],
		references: [mediaIngestsInAppPrivate.id]
	}),
	mediaDerivativesInAppPrivates: many(mediaDerivativesInAppPrivate),
}));

export const mediaIngestsInAppPrivateRelations = relations(mediaIngestsInAppPrivate, ({one, many}) => ({
	mediaAssetsInAppPrivates: many(mediaAssetsInAppPrivate),
	mediaIngestOperationsInAppPrivates: many(mediaIngestOperationsInAppPrivate),
	gamesInAppPrivate: one(gamesInAppPrivate, {
		fields: [mediaIngestsInAppPrivate.gameId],
		references: [gamesInAppPrivate.id]
	}),
}));

export const mediaCleanupJobsInAppPrivateRelations = relations(mediaCleanupJobsInAppPrivate, ({one}) => ({
	mediaDerivativeAttemptsInAppPrivate: one(mediaDerivativeAttemptsInAppPrivate, {
		fields: [mediaCleanupJobsInAppPrivate.attemptId],
		references: [mediaDerivativeAttemptsInAppPrivate.id]
	}),
}));

export const mediaDerivativeAttemptsInAppPrivateRelations = relations(mediaDerivativeAttemptsInAppPrivate, ({one, many}) => ({
	mediaCleanupJobsInAppPrivates: many(mediaCleanupJobsInAppPrivate),
	mediaDerivativesInAppPrivate: one(mediaDerivativesInAppPrivate, {
		fields: [mediaDerivativeAttemptsInAppPrivate.derivativeId],
		references: [mediaDerivativesInAppPrivate.id]
	}),
}));

export const mediaDerivativesInAppPrivateRelations = relations(mediaDerivativesInAppPrivate, ({one, many}) => ({
	mediaDerivativeAttemptsInAppPrivates: many(mediaDerivativeAttemptsInAppPrivate),
	mediaAssetsInAppPrivate: one(mediaAssetsInAppPrivate, {
		fields: [mediaDerivativesInAppPrivate.assetId],
		references: [mediaAssetsInAppPrivate.id]
	}),
}));

export const mediaIngestOperationsInAppPrivateRelations = relations(mediaIngestOperationsInAppPrivate, ({one}) => ({
	gamesInAppPrivate: one(gamesInAppPrivate, {
		fields: [mediaIngestOperationsInAppPrivate.gameId],
		references: [gamesInAppPrivate.id]
	}),
	mediaIngestsInAppPrivate: one(mediaIngestsInAppPrivate, {
		fields: [mediaIngestOperationsInAppPrivate.ingestId],
		references: [mediaIngestsInAppPrivate.id]
	}),
}));

export const notesInAppPrivateRelations = relations(notesInAppPrivate, ({one}) => ({
	gamesInAppPrivate: one(gamesInAppPrivate, {
		fields: [notesInAppPrivate.gameId],
		references: [gamesInAppPrivate.id]
	}),
}));

export const sourceContributionsInAppPrivateRelations = relations(sourceContributionsInAppPrivate, ({one}) => ({
	contributorsInAppPrivate: one(contributorsInAppPrivate, {
		fields: [sourceContributionsInAppPrivate.contributorId],
		references: [contributorsInAppPrivate.id]
	}),
	externalGameIdentitiesInAppPrivate: one(externalGameIdentitiesInAppPrivate, {
		fields: [sourceContributionsInAppPrivate.identityId],
		references: [externalGameIdentitiesInAppPrivate.id]
	}),
}));

export const sourceRefreshOperationsInAppPrivateRelations = relations(sourceRefreshOperationsInAppPrivate, ({one}) => ({
	externalGameIdentitiesInAppPrivate: one(externalGameIdentitiesInAppPrivate, {
		fields: [sourceRefreshOperationsInAppPrivate.externalGameIdentityId],
		references: [externalGameIdentitiesInAppPrivate.id]
	}),
	gamesInAppPrivate: one(gamesInAppPrivate, {
		fields: [sourceRefreshOperationsInAppPrivate.gameId],
		references: [gamesInAppPrivate.id]
	}),
}));