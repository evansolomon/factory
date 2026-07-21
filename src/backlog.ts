import { mkdir, readdir, rm } from 'node:fs/promises'
import { z } from 'zod'
import type { RepoContext } from './config.ts'
import { type TaskDelivery, TaskDeliverySchema } from './delivery.ts'

// The repo's backlog: vetted intents waiting to be dispatched to a worktree.
// One JSON file per entry under <repo-state>/backlog/. This is what you feed; the
// dispatcher (next) drains it by spawning a worker worktree per entry.

const EntrySchema = z.object({
  id: z.string(),
  intent: z.string(),
  verify: z.string().nullable().default(null),
  createdAt: z.string(),
  chainId: z.string().nullable().default(null),
  chainOrder: z.number().int().nonnegative().nullable().default(null),
  previousId: z.string().nullable().default(null),
  delivery: TaskDeliverySchema.nullable().default(null),
})
export type BacklogEntry = z.infer<typeof EntrySchema>

export type AddBacklogOptions = {
  suggestedId?: string
  chainId?: string
  chainOrder?: number
  previousId?: string
  delivery?: TaskDelivery
}

function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '')
  return slug.length > 0 ? slug : 'task'
}

async function entryFiles(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((f) => f.endsWith('.json')).sort()
  } catch {
    return []
  }
}

export async function addBacklog(
  ctx: RepoContext,
  intent: string,
  verify: string | null,
  options: AddBacklogOptions = {}
): Promise<BacklogEntry> {
  await mkdir(ctx.backlogDir, { recursive: true })
  // Descriptive, number-free id; disambiguate same-named entries with a -N suffix.
  const slug = slugify(options.suggestedId ?? intent.trim().split('\n', 1)[0] ?? '')
  const files = await entryFiles(ctx.backlogDir)
  let id = slug
  const existingPath = `${ctx.backlogDir}/${id}.json`
  if (files.includes(`${id}.json`) && options.chainId) {
    const existing = EntrySchema.safeParse(await Bun.file(existingPath).json())
    if (
      existing.success &&
      existing.data.chainId === options.chainId &&
      existing.data.chainOrder === (options.chainOrder ?? null)
    ) {
      return existing.data
    }
  }
  for (let n = 2; files.includes(`${id}.json`); n++) {
    id = `${slug}-${n}`
  }
  const entry: BacklogEntry = {
    id,
    intent: intent.trim(),
    verify,
    createdAt: new Date().toISOString(),
    chainId: options.chainId ?? null,
    chainOrder: options.chainOrder ?? null,
    previousId: options.previousId ?? null,
    delivery: options.delivery ?? null,
  }
  await Bun.write(`${ctx.backlogDir}/${id}.json`, `${JSON.stringify(entry, null, 2)}\n`)
  return entry
}

// Ordered oldest-first by createdAt (ids no longer carry a sortable number).
export async function loadBacklog(ctx: RepoContext): Promise<BacklogEntry[]> {
  const entries: BacklogEntry[] = []
  for (const file of await entryFiles(ctx.backlogDir)) {
    const parsed = EntrySchema.safeParse(await Bun.file(`${ctx.backlogDir}/${file}`).json())
    if (parsed.success) {
      entries.push(parsed.data)
    }
  }
  return entries.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
}

export function orderedChainEntries(
  entries: BacklogEntry[],
  chainId: string | undefined
): BacklogEntry[] {
  if (!chainId) {
    return entries
  }
  return entries
    .filter((entry) => entry.chainId === chainId)
    .sort((a, b) => (a.chainOrder ?? 0) - (b.chainOrder ?? 0))
}

export async function removeBacklog(
  ctx: RepoContext,
  query: string
): Promise<{ removed: BacklogEntry } | { ambiguous: BacklogEntry[] } | null> {
  const entries = await loadBacklog(ctx)
  const exact = entries.find((e) => e.id === query)
  const matches = exact ? [exact] : entries.filter((e) => e.id.includes(query))
  const entry = matches[0]
  if (!entry) {
    return null
  }
  if (matches.length > 1) {
    return { ambiguous: matches }
  }
  await rm(`${ctx.backlogDir}/${entry.id}.json`, { force: true })
  return { removed: entry }
}
