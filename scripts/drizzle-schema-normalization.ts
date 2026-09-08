function constraintName(block: string): string {
  return block.match(/\n\t\t\tname: "([^"]+)"/)?.[1] ?? block;
}

function relationField(block: string): string {
  return block.match(/^\t\tfields: \[([^\]]+)\]/m)?.[1] ?? block;
}

function relationName(block: string): string {
  return block.match(/^\t([A-Za-z_$][\w$]*):/)?.[1] ?? block;
}

function sortMatchedSlots(
  value: string,
  pattern: RegExp,
  key: (match: string) => string,
): string {
  const matches = [...value.matchAll(pattern)].map((match) => match[0]);
  if (matches.length < 2) return value;

  const sorted = [...matches].sort((left, right) => key(left).localeCompare(key(right), "en"));
  let index = 0;
  return value.replace(pattern, () => sorted[index++] ?? "");
}

const foreignKeyBlock = /^\tforeignKey\(\{\n(?:^\t{3}[^\n]*\n)+^\t{2}\}\)(?:\.onDelete\("[^"]+"\))?,\n/gm;
const relationEntryBoundary = /\n(?=^\t[A-Za-z_$][\w$]*:)/m;

export function normalizeSchemaOrdering(schema: string): string {
  return schema.replace(/\}, \(table\) => \[\n([\s\S]*?)\n\]\);/g, (table, body: string) => {
    const normalizedBody = sortMatchedSlots(body, foreignKeyBlock, constraintName);
    return table.replace(body, () => normalizedBody);
  });
}

export function normalizeRelationsOrdering(relations: string): string {
  const sortedImports = relations.replace(
    /import \{ ([^}]+) \} from "\.\/schema";/,
    (_line, names: string) =>
      `import { ${names.split(",").map((name) => name.trim()).sort((left, right) => left.localeCompare(right, "en")).join(", ")} } from "./schema";`,
  );

  return sortedImports.replace(/=> \(\{\n([\s\S]*?)\n\}\)\);/g, (relation, body: string) => {
    const entries = body.split(relationEntryBoundary);
    const hasFields = (entry: string) => /^\t\tfields: \[/m.test(entry);
    const normalizedEntries: string[] = [];
    for (let start = 0; start < entries.length;) {
      let end = start + 1;
      while (end < entries.length && hasFields(entries[end] ?? "") === hasFields(entries[start] ?? "")) end += 1;
      const key = hasFields(entries[start] ?? "") ? relationField : relationName;
      normalizedEntries.push(...entries.slice(start, end).sort((left, right) => key(left).localeCompare(key(right), "en")));
      start = end;
    }
    const normalizedBody = normalizedEntries.join("\n");
    return relation.replace(body, () => normalizedBody);
  });
}
