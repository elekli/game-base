import { relations } from "drizzle-orm/relations";
import { externalGameIdentitiesInAppPrivate, gamesInAppPrivate, gameNamesInAppPrivate, externalGameCategoriesInAppPrivate, sourceCategoriesInAppPrivate, sourceContributionsInAppPrivate, externalPlayerProfilesInAppPrivate, mediaIngestsInAppPrivate, mediaAssetsInAppPrivate, mediaDerivativesInAppPrivate } from "./schema";

export const gamesInAppPrivateRelations = relations(gamesInAppPrivate, ({one, many}) => ({
	externalGameIdentitiesInAppPrivate: one(externalGameIdentitiesInAppPrivate, {
		fields: [gamesInAppPrivate.externalGameIdentityId],
		references: [externalGameIdentitiesInAppPrivate.id]
	}),
	gameNamesInAppPrivates: many(gameNamesInAppPrivate),
	mediaIngestsInAppPrivates: many(mediaIngestsInAppPrivate),
}));

export const externalGameIdentitiesInAppPrivateRelations = relations(externalGameIdentitiesInAppPrivate, ({many}) => ({
	gamesInAppPrivates: many(gamesInAppPrivate),
	externalGameCategoriesInAppPrivates: many(externalGameCategoriesInAppPrivate),
	sourceContributionsInAppPrivates: many(sourceContributionsInAppPrivate),
	externalPlayerProfilesInAppPrivates: many(externalPlayerProfilesInAppPrivate),
}));

export const gameNamesInAppPrivateRelations = relations(gameNamesInAppPrivate, ({one}) => ({
	gamesInAppPrivate: one(gamesInAppPrivate, {
		fields: [gameNamesInAppPrivate.gameId],
		references: [gamesInAppPrivate.id]
	}),
}));

export const externalGameCategoriesInAppPrivateRelations = relations(externalGameCategoriesInAppPrivate, ({one}) => ({
	externalGameIdentitiesInAppPrivate: one(externalGameIdentitiesInAppPrivate, {
		fields: [externalGameCategoriesInAppPrivate.identityId],
		references: [externalGameIdentitiesInAppPrivate.id]
	}),
	sourceCategoriesInAppPrivate: one(sourceCategoriesInAppPrivate, {
		fields: [externalGameCategoriesInAppPrivate.categoryId],
		references: [sourceCategoriesInAppPrivate.id]
	}),
}));

export const sourceCategoriesInAppPrivateRelations = relations(sourceCategoriesInAppPrivate, ({many}) => ({
	externalGameCategoriesInAppPrivates: many(externalGameCategoriesInAppPrivate),
}));

export const sourceContributionsInAppPrivateRelations = relations(sourceContributionsInAppPrivate, ({one}) => ({
	externalGameIdentitiesInAppPrivate: one(externalGameIdentitiesInAppPrivate, {
		fields: [sourceContributionsInAppPrivate.identityId],
		references: [externalGameIdentitiesInAppPrivate.id]
	}),
}));

export const externalPlayerProfilesInAppPrivateRelations = relations(externalPlayerProfilesInAppPrivate, ({one}) => ({
	externalGameIdentitiesInAppPrivate: one(externalGameIdentitiesInAppPrivate, {
		fields: [externalPlayerProfilesInAppPrivate.identityId],
		references: [externalGameIdentitiesInAppPrivate.id]
	}),
}));

export const mediaIngestsInAppPrivateRelations = relations(mediaIngestsInAppPrivate, ({one, many}) => ({
	gamesInAppPrivate: one(gamesInAppPrivate, {
		fields: [mediaIngestsInAppPrivate.gameId],
		references: [gamesInAppPrivate.id]
	}),
	mediaAssetsInAppPrivates: many(mediaAssetsInAppPrivate),
}));

export const mediaAssetsInAppPrivateRelations = relations(mediaAssetsInAppPrivate, ({one, many}) => ({
	mediaIngestsInAppPrivate: one(mediaIngestsInAppPrivate, {
		fields: [mediaAssetsInAppPrivate.ingestId],
		references: [mediaIngestsInAppPrivate.id]
	}),
	mediaDerivativesInAppPrivates: many(mediaDerivativesInAppPrivate),
}));

export const mediaDerivativesInAppPrivateRelations = relations(mediaDerivativesInAppPrivate, ({one}) => ({
	mediaAssetsInAppPrivate: one(mediaAssetsInAppPrivate, {
		fields: [mediaDerivativesInAppPrivate.assetId],
		references: [mediaAssetsInAppPrivate.id]
	}),
}));