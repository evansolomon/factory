import { mkdir, readdir, rm } from 'node:fs/promises'
import { z } from 'zod'
import type { RepoContext } from './config.ts'

// The repo's backlog: vetted intents waiting to be dispatched to a worktree.
// One JSON file per entry under <repo-state>/backlog/. This is what you feed; the
// dispatcher (next) drains it by spawning a worker worktree per entry.

const EntrySchema = z.object({
  id: z.string(),
  intent: z.string(),
  verify: z.string().nullable().default(null),
  createdAt: z.string(),
})
export type BacklogEntry = z.infer<typeof EntrySchema>

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
  verify: string | null
): Promise<BacklogEntry> {
  await mkdir(ctx.backlogDir, { recursive: true })
  // Descriptive, number-free id; disambiguate same-named entries with a -N suffix.
  const slug = slugify(intent.trim().split('\n', 1)[0] ?? '')
  const files = await entryFiles(ctx.backlogDir)
  let id = slug
  for (let n = 2; files.includes(`${id}.json`); n++) {
    id = `${slug}-${n}`
  }
  const entry: BacklogEntry = {
    id,
    intent: intent.trim(),
    verify,
    createdAt: new Date().toISOString(),
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
