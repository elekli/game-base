"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { ContributionRole, ContributorFacet, GameRecord, Medium, SharedLibraryItem, SourceCategory } from "@/modules/games";
import { compatibleSourceCategoryKinds, normalizeSharedName, type LibraryFilters } from "@/modules/library";
import { deletePlatform, deleteTag } from "@/app/private-mutation-actions";
import type { PrivateActionResult } from "@/shared/auth/private-action";
import { buildLibrarySearchParams, parseLibraryUrlSearchParams } from "./library-search-params";
import { PrivateCoverImage } from "./private-cover-image";

type Props = Readonly<{ games: readonly GameRecord[]; sourceCategories: readonly SourceCategory[]; contributorFacets: readonly ContributorFacet[]; filters: LibraryFilters; sharedPlatforms: readonly SharedLibraryItem[]; sharedTags: readonly SharedLibraryItem[] }>;

const mediumLabels: Record<Medium, string> = { board_game: "桌遊", video_game: "電子遊戲" };
const roleLabels: Record<ContributionRole, string> = { design: "設計／開發", art: "美術", publisher: "發行" };
const contributionRoles = Object.keys(roleLabels) as ContributionRole[];

function contributorFacetBaseLabel(facet: ContributorFacet): string {
  const source = facet.provider === "bgg" ? "BGG" : facet.provider === "igdb" ? "IGDB" : "手動";
  const kind = facet.entityKind === "person" ? "人物" : "組織";
  return `${facet.name}（${source}／${kind}／${roleLabels[facet.role]}）`;
}

function contributorFacetLabel(facet: ContributorFacet, facets: readonly ContributorFacet[]): string {
  const base = contributorFacetBaseLabel(facet);
  const ambiguous = facets.filter((candidate) => candidate.role === facet.role && contributorFacetBaseLabel(candidate) === base).length > 1;
  return ambiguous ? `${base.slice(0, -1)}／${facet.contributorId.slice(0, 8)}）` : base;
}

type FormState = Readonly<{
  search: string;
  media: Medium[];
  platforms: string[];
  tags: string[];
  contributorIds: string[];
  contributorRoles: Record<ContributionRole, string[]>;
  categories: string[];
  sort: string;
  weightMin: string;
  weightMax: string;
}>;

function initialFormState(filters: LibraryFilters, sharedPlatforms: readonly SharedLibraryItem[], sharedTags: readonly SharedLibraryItem[]): FormState {
  const selectedPlatforms = new Set((filters.actualPlatforms ?? []).map(normalizeSharedName));
  const selectedTags = new Set((filters.tags ?? []).map(normalizeSharedName));
  return {
    search: filters.search ?? "",
    media: [...(filters.media ?? [])],
    platforms: sharedPlatforms.filter((item) => selectedPlatforms.has(normalizeSharedName(item.name))).map((item) => item.name),
    tags: sharedTags.filter((item) => selectedTags.has(normalizeSharedName(item.name))).map((item) => item.name),
    contributorIds: [...(filters.contributorIds ?? [])],
    contributorRoles: Object.fromEntries(contributionRoles.map((role) => [role, filters.contributorRoles?.find((group) => group.role === role)?.contributorIds ?? []])) as Record<ContributionRole, string[]>,
    categories: (filters.sourceCategories ?? []).map((category) => `${category.kind}:${category.sourceCategoryId}`),
    sort: filters.sort ?? "name",
    weightMin: filters.weightMin?.toString() ?? "",
    weightMax: filters.weightMax?.toString() ?? "",
  };
}

function unwrapPrivateAction<Success extends object>(result: PrivateActionResult<Success>): Success {
  if (!result.ok) throw new Error(result.message);
  return result;
}

export function LibraryClient({ games, sourceCategories, contributorFacets, filters, sharedPlatforms, sharedTags }: Props) {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sharedItemsRef = useRef({ platforms: sharedPlatforms, tags: sharedTags });
  const [message, setMessage] = useState("");
  const [formState, setFormState] = useState(() => initialFormState(filters, sharedPlatforms, sharedTags));
  const visibleSourceCategories = sourceCategories.filter((category) => compatibleSourceCategoryKinds(formState.media).includes(category.kind));
  function cancelScheduledSearch() {
    if (!searchTimer.current) return;
    clearTimeout(searchTimer.current);
    searchTimer.current = null;
  }
  function scheduleSearch() {
    cancelScheduledSearch();
    searchTimer.current = setTimeout(() => {
      searchTimer.current = null;
      if (!formRef.current) return;
      const params = buildLibrarySearchParams(new FormData(formRef.current));
      const target = params.toString() ? `/?${params.toString()}` : "/";
      router.replace(target, { scroll: false });
    }, 300);
  }
  function toggle(field: "media" | "platforms" | "tags" | "categories", value: string, checked: boolean) {
    setFormState((current) => ({ ...current, [field]: checked ? [...current[field], value] : current[field].filter((item) => item !== value) }));
  }
  function toggleContributor(role: ContributionRole, contributorId: string, checked: boolean) {
    setFormState((current) => ({
      ...current,
      contributorRoles: {
        ...current.contributorRoles,
        [role]: checked ? [...current.contributorRoles[role], contributorId] : current.contributorRoles[role].filter((item) => item !== contributorId),
      },
    }));
  }
  function clearFilters() {
    cancelScheduledSearch();
    setFormState(initialFormState({}, sharedPlatforms, sharedTags));
    router.push("/", { scroll: false });
  }
  useEffect(() => {
    sharedItemsRef.current = { platforms: sharedPlatforms, tags: sharedTags };
  }, [sharedPlatforms, sharedTags]);
  useEffect(() => {
    const syncBrowserNavigation = () => {
      if (searchTimer.current) clearTimeout(searchTimer.current);
      searchTimer.current = null;
      setFormState(initialFormState(parseLibraryUrlSearchParams(new URLSearchParams(window.location.search)), sharedItemsRef.current.platforms, sharedItemsRef.current.tags));
    };
    window.addEventListener("popstate", syncBrowserNavigation);
    return () => {
      window.removeEventListener("popstate", syncBrowserNavigation);
      if (searchTimer.current) clearTimeout(searchTimer.current);
    };
  }, []);
  async function deleteShared(item: SharedLibraryItem, action: typeof deletePlatform | typeof deleteTag) {
    if (item.isSystem || item.usageCount > 0 || !window.confirm(`確定刪除「${item.name}」？`)) return;
    unwrapPrivateAction(await action({ name: item.name }));
    window.location.reload();
  }
  return <>
    <form ref={formRef} className="mb-6 space-y-3 rounded-2xl border border-slate-200 bg-white p-4" role="search" onSubmit={(event) => { event.preventDefault(); cancelScheduledSearch(); const params = buildLibrarySearchParams(new FormData(event.currentTarget)); window.location.assign(params.toString() ? `/?${params.toString()}` : "/"); }}>
      {formState.contributorIds.map((contributorId) => <input key={contributorId} type="hidden" name="contributor" value={contributorId} />)}
      {(formState.contributorIds.length > 0 || contributionRoles.some((role) => formState.contributorRoles[role].length > 0)) && <p className="rounded-xl bg-emerald-50 px-3 py-2 text-sm text-emerald-900">已依貢獻者篩選收藏庫；可繼續組合其他條件。</p>}
      <div><label className="mb-2 block text-sm font-medium" htmlFor="library-search">搜尋收藏庫</label><input id="library-search" name="search" type="search" value={formState.search} onChange={(event) => { setFormState((current) => ({ ...current, search: event.target.value })); scheduleSearch(); }} placeholder="名稱、原文名稱或別名" className="min-h-11 w-full rounded-xl border border-slate-300 px-3 py-2 text-base" /></div>
      <fieldset><legend className="mb-2 text-sm font-medium">遊戲類型</legend><div className="flex flex-wrap gap-3">{(Object.keys(mediumLabels) as Medium[]).map((medium) => <label className="flex items-center gap-2 text-sm" key={medium}><input type="checkbox" name="medium" value={medium} checked={formState.media.includes(medium)} onChange={(event) => toggle("media", medium, event.target.checked)} />{mediumLabels[medium]}</label>)}</div></fieldset>
      {sharedPlatforms.length > 0 && <fieldset><legend className="text-sm font-medium">實際平台</legend><p className="mt-1 text-xs text-slate-500">選取多個平台時，符合任一平台即可。</p><div className="mt-2 flex flex-wrap gap-2">{sharedPlatforms.map((platform) => <label className="flex min-h-11 items-center gap-2 rounded-full border border-slate-200 px-3 py-2 text-sm" key={platform.name}><input type="checkbox" name="platform" value={platform.name} checked={formState.platforms.includes(platform.name)} onChange={(event) => toggle("platforms", platform.name, event.target.checked)} />{platform.name}</label>)}</div></fieldset>}
      {sharedTags.length > 0 && <fieldset><legend className="text-sm font-medium">自由標籤</legend><p className="mt-1 text-xs text-slate-500">標籤內取聯集，並與其他條件交集。</p><div className="mt-2 flex flex-wrap gap-2">{sharedTags.map((tag) => <label className="flex min-h-11 items-center gap-2 rounded-full border border-slate-200 px-3 py-2 text-sm" key={tag.name}><input type="checkbox" name="tag" value={tag.name} checked={formState.tags.includes(tag.name)} onChange={(event) => toggle("tags", tag.name, event.target.checked)} />{tag.name}</label>)}</div></fieldset>}
      {formState.media.length === 1 && visibleSourceCategories.length > 0 && <fieldset><legend className="mb-2 text-sm font-medium">來源分類</legend><div className="grid grid-cols-2 gap-2">{visibleSourceCategories.map((category) => { const value = `${category.kind}:${category.sourceCategoryId}`; return <label className="flex items-center gap-2 text-sm" key={value}><input type="checkbox" name="category" value={value} checked={formState.categories.includes(value)} onChange={(event) => toggle("categories", value, event.target.checked)} />{category.name}</label>; })}</div></fieldset>}
      {contributorFacets.length > 0 && <fieldset><legend className="text-sm font-medium">貢獻者</legend><p className="mt-1 text-xs text-slate-500">同一分類取聯集，不同分類取交集。</p><div className="mt-3 grid gap-3 sm:grid-cols-3">{contributionRoles.map((role) => { const facets = contributorFacets.filter((facet) => facet.role === role); return facets.length > 0 && <div key={role}><h2 className="text-xs font-semibold text-slate-600">{roleLabels[role]}</h2><div className="mt-1 space-y-1">{facets.map((facet) => { const label = contributorFacetLabel(facet, contributorFacets); return <label className="flex min-h-11 items-center gap-2 rounded-xl border border-slate-200 px-3 py-2 text-sm" key={`${role}:${facet.contributorId}`}><input aria-label={label} type="checkbox" name={`contributor-${role}`} value={facet.contributorId} checked={formState.contributorRoles[role].includes(facet.contributorId)} onChange={(event) => toggleContributor(role, facet.contributorId, event.target.checked)} /><span className="min-w-0 break-words">{label}</span></label>; })}</div></div>; })}</div></fieldset>}
      <div className="flex flex-wrap items-center gap-3"><label className="text-sm font-medium" htmlFor="library-sort">排序</label><select id="library-sort" name="sort" value={formState.sort} onChange={(event) => setFormState((current) => ({ ...current, sort: event.target.value }))} className="min-h-11 rounded-xl border border-slate-300 px-3 py-2 text-sm"><option value="name">名稱</option><option value="recent">最近新增</option>{formState.media.length === 1 && formState.media[0] === "board_game" && <><option value="weight_asc">重度：輕到重</option><option value="weight_desc">重度：重到輕</option><option value="strategy_rank">Strategy Game Rank</option></>}</select>{formState.media.length === 1 && formState.media[0] === "board_game" && <><label className="sr-only" htmlFor="weight-min">最低重度</label><input id="weight-min" name="weightMin" inputMode="decimal" placeholder="最低重度" className="min-h-11 w-24 rounded-xl border border-slate-300 px-3 py-2 text-sm" value={formState.weightMin} onChange={(event) => setFormState((current) => ({ ...current, weightMin: event.target.value }))} /><label className="sr-only" htmlFor="weight-max">最高重度</label><input id="weight-max" name="weightMax" inputMode="decimal" placeholder="最高重度" className="min-h-11 w-24 rounded-xl border border-slate-300 px-3 py-2 text-sm" value={formState.weightMax} onChange={(event) => setFormState((current) => ({ ...current, weightMax: event.target.value }))} /></>}<button type="submit" className="min-h-11 rounded-xl bg-emerald-900 px-4 py-2 text-sm font-semibold text-white">套用篩選</button><Link href="/" onClick={(event) => { event.preventDefault(); clearFilters(); }} className="flex min-h-11 items-center px-2 text-sm font-semibold text-emerald-900">清除全部條件</Link></div>
    </form>
    {message && <p role="status" className="mb-4 text-sm text-rose-700">{message}</p>}<details className="mb-6 rounded-2xl border border-slate-200 bg-white p-4"><summary className="cursor-pointer font-semibold">管理共享平台與標籤</summary><div className="mt-4 grid gap-4 sm:grid-cols-2"><div><h2 className="text-sm font-medium">平台</h2><ul className="mt-2 space-y-2 text-sm">{sharedPlatforms.map((item) => <li className="flex items-center justify-between gap-2" key={item.name}><span>{item.name} <span className="text-slate-500">（{item.usageCount} 款使用）</span></span>{!item.isSystem && (item.usageCount === 0 ? <button type="button" className="text-rose-700" onClick={() => void deleteShared(item, deletePlatform).catch((error) => setMessage(error instanceof Error ? error.message : "刪除失敗。"))}>刪除</button> : <span className="text-slate-500">使用中，請先移除關係</span>)}</li>)}</ul></div><div><h2 className="text-sm font-medium">標籤</h2><ul className="mt-2 space-y-2 text-sm">{sharedTags.map((item) => <li className="flex items-center justify-between gap-2" key={item.name}><span>{item.name} <span className="text-slate-500">（{item.usageCount} 款使用）</span></span>{item.usageCount === 0 ? <button type="button" className="text-rose-700" onClick={() => void deleteShared(item, deleteTag).catch((error) => setMessage(error instanceof Error ? error.message : "刪除失敗。"))}>刪除</button> : <span className="text-slate-500">使用中，請先移除關係</span>}</li>)}</ul></div></div></details>
    {games.length === 0 ? <p className="rounded-2xl border border-dashed border-slate-300 bg-white/50 p-8 text-center text-slate-600">沒有符合條件的遊戲。</p> : <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3">{games.map((game) => <li key={game.id}><Link href={`/games/${game.id}`} className="block rounded-2xl border border-slate-200 bg-white p-4 shadow-sm"><PrivateCoverImage key={game.coverAssetId ?? "none"} assetId={game.coverAssetId} alt={`${game.displayName}封面`} className="aspect-[4/5] rounded-xl" /><h2 className="mt-3 font-semibold">{game.displayName}</h2><p className="mt-1 text-sm text-slate-500">{mediumLabels[game.medium]}{game.medium === "board_game" && game.snapshot?.weight !== null && game.snapshot?.weight !== undefined ? ` · 重度 ${game.snapshot.weight}` : ""}</p>{game.medium === "video_game" && game.actualPlatforms.length > 0 && <p className="mt-1 truncate text-xs text-slate-500">{game.actualPlatforms.join("、")}</p>}</Link></li>)}</ul>}
  </>;
}
