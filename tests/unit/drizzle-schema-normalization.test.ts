import { describe, expect, it } from "vitest";
import { normalizeRelationsOrdering, normalizeSchemaOrdering } from "../../scripts/drizzle-schema-normalization";

const foreignKey = (name: string, column: string) => `\tforeignKey({
\t\t\tcolumns: [table.${column}],
\t\t\tforeignColumns: [parents.id],
\t\t\tname: "${name}"
\t\t}).onDelete("cascade"),
`;

const relation = (name: string, column: string) => `\t${name}: one(parents, {
\t\tfields: [children.${column}],
\t\treferences: [parents.id]
\t}),
`;

const reverseRelation = (name: string) => `\t${name}Children: many(children, {
\t\trelationName: "${name}"
\t}),
`;

describe("Drizzle schema normalization", () => {
  it("sorts foreign keys within their table without moving other declarations", () => {
    const first = `export const children = table("children", {}, (table) => [
\tindex("children_idx"),
${foreignKey("children_z_fkey", "zId")}${foreignKey("children_a_fkey", "aId")}\tpolicy("children_policy"),
]);`;
    const second = first.replace(
      `${foreignKey("children_z_fkey", "zId")}${foreignKey("children_a_fkey", "aId")}`,
      `${foreignKey("children_a_fkey", "aId")}${foreignKey("children_z_fkey", "zId")}`,
    );

    expect(normalizeSchemaOrdering(first)).toBe(normalizeSchemaOrdering(second));
    expect(normalizeSchemaOrdering(first)).toContain(
      `\tindex("children_idx"),\n${foreignKey("children_a_fkey", "aId")}${foreignKey("children_z_fkey", "zId")}\tpolicy`,
    );
  });

  it("sorts schema imports and one-to-one relations by their local fields", () => {
    const first = `import { parents, children } from "./schema";

export const childRelations = relations(children, ({one}) => ({
${relation("zParent", "zId")}${relation("aParent", "aId")}\tmanyChildren: many(children),
}));`;
    const second = first
      .replace("parents, children", "children, parents")
      .replace(
        `${relation("zParent", "zId")}${relation("aParent", "aId")}`,
        `${relation("aParent", "aId")}${relation("zParent", "zId")}`,
      );

    expect(normalizeRelationsOrdering(first)).toBe(normalizeRelationsOrdering(second));
    expect(normalizeRelationsOrdering(first)).toContain("import { children, parents }");
    expect(normalizeRelationsOrdering(first)).toContain(
      `${relation("aParent", "aId")}${relation("zParent", "zId")}\tmanyChildren`,
    );
  });

  it("sorts reverse relations without moving them into forward-relation slots", () => {
    const first = `import { children, parents } from "./schema";

export const parentRelations = relations(parents, ({one, many}) => ({
${reverseRelation("z")}${reverseRelation("a")}${relation("owner", "ownerId")}\tmembers: many(children),
}));`;
    const second = first.replace(
      `${reverseRelation("z")}${reverseRelation("a")}`,
      `${reverseRelation("a")}${reverseRelation("z")}`,
    );

    expect(normalizeRelationsOrdering(first)).toBe(normalizeRelationsOrdering(second));
    expect(normalizeRelationsOrdering(first)).toMatch(/aChildren:[\s\S]+zChildren:[\s\S]+owner:[\s\S]+members:/);
  });

  it("preserves JavaScript replacement tokens in generated SQL and relation metadata", () => {
    const schema = `export const children = table("children", {}, (table) => [
${foreignKey("children_z_fkey", "zId")}${foreignKey("children_a_fkey", "aId")}\tpolicy(sql\`$& $$\`),
]);`;
    const relations = `export const parentRelations = relations(parents, ({many}) => ({
${reverseRelation("z")}${reverseRelation("a")}\tmetadata: many(sql\`$& $$\`),
}));`;

    expect(normalizeSchemaOrdering(schema)).toBe(schema.replace(
      `${foreignKey("children_z_fkey", "zId")}${foreignKey("children_a_fkey", "aId")}`,
      `${foreignKey("children_a_fkey", "aId")}${foreignKey("children_z_fkey", "zId")}`,
    ));
    expect(normalizeRelationsOrdering(relations)).toBe(relations.replace(
      `${reverseRelation("z")}${reverseRelation("a")}\tmetadata: many(sql\`$& $$\`),`,
      () => `${reverseRelation("a")}\tmetadata: many(sql\`$& $$\`),\n${reverseRelation("z").trimEnd()}`,
    ));
  });
});
