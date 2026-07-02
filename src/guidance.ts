import { randomUUID } from 'node:crypto'
import { mkdir, readdir, rename } from 'node:fs/promises'
import { dirname } from 'node:path'
import { z } from 'zod'
import { guidanceDir, type WorkContext } from './config.ts'
import { log } from './log.ts'

export const GuidanceStageSchema = z.enum([
  'plan',
  'critique',
  'reconcile',
  'prototype',
  'implement',
  'fix',
  'review',
  'security',
  'deploy-safety',
  'ux-review',
  'consolidate',
  'remediate',
  'postmortem',
])

export type GuidanceStage = z.infer<typeof GuidanceStageSchema>
export const GUIDANCE_STAGE_VALUES = GuidanceStageSchema.options

const GuidanceScopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('global') }),
  z.object({
    kind: z.literal('repo'),
    repoStateDir: z.string().min(1),
    repoRoot: z.string().min(1),
  }),
])

const GuidanceSourceSchema = z.object({
  kind: z.enum(['postmortem', 'correction', 'manual']),
  taskId: z.string().nullable().default(null),
  detail: z.string().nullable().default(null),
})

export const GuidanceRecordSchema = z.object({
  id: z.string().min(1),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  source: GuidanceSourceSchema,
  scope: GuidanceScopeSchema,
  stages: z.array(GuidanceStageSchema).min(1),
  tags: z.array(z.string()).default([]),
  text: z.string().min(1),
  rationale: z.string().nullable().default(null),
  status: z.enum(['active', 'deleted', 'retired']).default('active'),
  deletedAt: z.string().nullable().default(null),
  // Outcome tracking: how many runs this lesson was injected into, and how many
  // of those ended done vs blocked. A lesson that keeps riding failing runs is
  // auto-retired — guidance must earn its context window.
  applied: z.number().int().nonnegative().default(0),
  wins: z.number().int().nonnegative().default(0),
  losses: z.number().int().nonnegative().default(0),
})

export type GuidanceRecord = z.infer<typeof GuidanceRecordSchema>

export type GuidanceScope = GuidanceRecord['scope']
export type GuidanceSource = GuidanceRecord['source']

const GuidanceCaptureSchema = z.object({
  actionable: z.boolean(),
  scope: z.enum(['global', 'repo']),
  stages: z.array(GuidanceStageSchema).min(1),
})

export type GuidanceCapture = z.infer<typeof GuidanceCaptureSchema>

const RENDER_LIMIT = 12

function itemsDir(): string {
  return `${guidanceDir()}/items`
}

function itemPath(id: string): string {
  return `${itemsDir()}/${id}.json`
}

function sortNewest(records: GuidanceRecord[]): GuidanceRecord[] {
  return [...records].sort((a, b) => {
    const updatedOrder = b.updatedAt.localeCompare(a.updatedAt)
    return updatedOrder === 0 ? a.id.localeCompare(b.id) : updatedOrder
  })
}

function errorCode(err: unknown): string | null {
  if (err && typeof err === 'object' && 'code' in err) {
    const code = err.code
    return typeof code === 'string' ? code : null
  }
  return null
}

function repoScope(ctx: WorkContext): GuidanceScope {
  return { kind: 'repo', repoStateDir: ctx.repoStateDir, repoRoot: ctx.root }
}

export function scopeForContext(ctx: WorkContext, scope: 'global' | 'repo'): GuidanceScope {
  return scope === 'global' ? { kind: 'global' } : repoScope(ctx)
}

function scopeMatches(ctx: WorkContext, record: GuidanceRecord): boolean {
  return record.scope.kind === 'global' || record.scope.repoStateDir === ctx.repoStateDir
}

export async function loadGuidance(): Promise<GuidanceRecord[]> {
  const dir = itemsDir()
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch (err) {
    if (errorCode(err) === 'ENOENT') {
      return []
    }
    log.warn(`guidance load failed: ${err instanceof Error ? err.message : err}`)
    return []
  }

  const records: GuidanceRecord[] = []
  for (const entry of entries) {
    if (!entry.endsWith('.json')) {
      continue
    }
    const path = `${dir}/${entry}`
    try {
      const raw: unknown = await Bun.file(path).json()
      const parsed = GuidanceRecordSchema.safeParse(raw)
      if (!parsed.success) {
        log.warn(`guidance record skipped (${entry}): ${parsed.error.issues[0]?.message}`)
        continue
      }
      records.push(parsed.data)
    } catch (err) {
      log.warn(`guidance record skipped (${entry}): ${err instanceof Error ? err.message : err}`)
    }
  }
  return sortNewest(records)
}

export function applicableGuidance(
  records: GuidanceRecord[],
  ctx: WorkContext,
  stage: GuidanceStage
): GuidanceRecord[] {
  return sortNewest(
    records.filter(
      (record) =>
        record.status === 'active' && record.stages.includes(stage) && scopeMatches(ctx, record)
    )
  )
}

function normalizedText(text: string): string {
  return text.trim().replace(/\s+/g, ' ').toLowerCase()
}

function scopeLabel(scope: GuidanceScope): string {
  return scope.kind
}

export function renderGuidanceBlock(
  records: GuidanceRecord[],
  usedIds?: Set<string>
): string | null {
  const seen = new Set<string>()
  const rendered: GuidanceRecord[] = []
  let deduped = 0
  for (const record of sortNewest(records)) {
    const normalized = normalizedText(record.text)
    if (seen.has(normalized)) {
      deduped++
      continue
    }
    seen.add(normalized)
    if (rendered.length < RENDER_LIMIT) {
      rendered.push(record)
      usedIds?.add(record.id)
    }
  }
  const capped = Math.max(0, seen.size - rendered.length)
  if (deduped > 0 || capped > 0) {
    log.warn(`guidance render dropped ${deduped} duplicate and ${capped} over-cap records`)
  }
  if (rendered.length === 0) {
    return null
  }
  return [
    '## Learned lessons (auto-applied; edit with `factory lessons edit <id>`)',
    ...rendered.map((record) => `- [${scopeLabel(record.scope)} ${record.id}] ${record.text}`),
  ].join('\n')
}

async function writeRecord(record: GuidanceRecord): Promise<void> {
  const path = itemPath(record.id)
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`
  await Bun.write(tmp, `${JSON.stringify(record, null, 2)}\n`)
  await rename(tmp, path)
}

export async function createGuidanceRecord(
  _ctx: WorkContext,
  input: {
    source: GuidanceRecord['source']
    scope: GuidanceRecord['scope']
    stages: GuidanceStage[]
    tags?: string[]
    text: string
    rationale?: string | null
  }
): Promise<GuidanceRecord> {
  const now = new Date().toISOString()
  const record = GuidanceRecordSchema.parse({
    id: randomUUID(),
    createdAt: now,
    updatedAt: now,
    source: input.source,
    scope: input.scope,
    stages: input.stages,
    tags: input.tags ?? [],
    text: input.text,
    rationale: input.rationale ?? null,
    status: 'active',
    deletedAt: null,
  })
  await writeRecord(record)
  return record
}

export async function listGuidance(
  ctx: WorkContext,
  opts: {
    includeDeleted?: boolean
    scope?: 'global' | 'repo'
    stage?: GuidanceStage
  } = {}
): Promise<GuidanceRecord[]> {
  const records = await loadGuidance()
  return sortNewest(
    records.filter((record) => {
      if (!opts.includeDeleted && record.status === 'deleted') {
        return false
      }
      if (opts.scope && record.scope.kind !== opts.scope) {
        return false
      }
      if (opts.scope !== 'global' && !scopeMatches(ctx, record)) {
        return false
      }
      if (opts.stage && !record.stages.includes(opts.stage)) {
        return false
      }
      return true
    })
  )
}

type GuidanceLookup = { record: GuidanceRecord } | { ambiguous: GuidanceRecord[] } | null

export async function findGuidance(
  ctx: WorkContext,
  query: string,
  opts: { includeDeleted?: boolean } = {}
): Promise<GuidanceLookup> {
  const records = await listGuidance(ctx, { includeDeleted: opts.includeDeleted })
  const exact = records.find((record) => record.id === query)
  if (exact) {
    return { record: exact }
  }
  const partial = records.filter((record) => record.id.startsWith(query))
  if (partial.length === 0) {
    return null
  }
  if (partial.length > 1) {
    return { ambiguous: partial }
  }
  const record = partial[0]
  return record ? { record } : null
}

export async function deleteGuidance(
  ctx: WorkContext,
  query: string
): Promise<{ deleted: GuidanceRecord } | { ambiguous: GuidanceRecord[] } | null> {
  const found = await findGuidance(ctx, query)
  if (!found || 'ambiguous' in found) {
    return found
  }
  const now = new Date().toISOString()
  const deleted = GuidanceRecordSchema.parse({
    ...found.record,
    updatedAt: now,
    status: 'deleted',
    deletedAt: now,
  })
  await writeRecord(deleted)
  return { deleted }
}

export async function editGuidance(
  ctx: WorkContext,
  query: string,
  patch: {
    text?: string
    stages?: GuidanceStage[]
    scope?: GuidanceRecord['scope']
  }
): Promise<{ edited: GuidanceRecord } | { ambiguous: GuidanceRecord[] } | null> {
  const found = await findGuidance(ctx, query, { includeDeleted: true })
  if (!found || 'ambiguous' in found) {
    return found
  }
  const edited = GuidanceRecordSchema.parse({
    ...found.record,
    updatedAt: new Date().toISOString(),
    text: patch.text ?? found.record.text,
    stages: patch.stages ?? found.record.stages,
    scope: patch.scope ?? found.record.scope,
  })
  await writeRecord(edited)
  return { edited }
}

function markerValue(text: string, marker: string): string | null {
  const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`^${escaped}:\\s*(.+)$`, 'im').exec(text)?.[1]?.trim() ?? null
}

export function parseGuidanceCapture(text: string): GuidanceCapture | null {
  const actionableRaw = markerValue(text, 'ACTIONABLE')
  if (!actionableRaw) {
    return null
  }
  const actionable = actionableRaw.toUpperCase()
  if (actionable !== 'YES' && actionable !== 'NO') {
    return null
  }
  if (actionable === 'NO') {
    return { actionable: false, scope: 'global', stages: ['plan'] }
  }

  const scopeRaw = markerValue(text, 'SCOPE')?.toUpperCase() ?? 'GLOBAL'
  const scope = scopeRaw === 'REPO' ? 'repo' : scopeRaw === 'GLOBAL' ? 'global' : null
  const stagesRaw = markerValue(text, 'STAGES')
  if (!scope || !stagesRaw) {
    return null
  }
  const stages = stagesRaw
    .split(',')
    .map((stage) => stage.trim())
    .filter((stage) => stage.length > 0)
  const parsed = GuidanceCaptureSchema.safeParse({
    actionable: true,
    scope,
    stages,
  })
  return parsed.success ? parsed.data : null
}

// Cheap semantic dedup: token-set Jaccard similarity. Near-duplicate lessons
// ("re-run tapioca with --no-regen when it OOMs" captured four separate times in
// real usage) accrue as separate records under exact-text dedup and crowd out
// the render cap.
const SIMILARITY_STOPWORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'when',
  'that',
  'this',
  'from',
  'into',
  'gets',
  'using',
  'always',
  'never',
  'should',
])

export function guidanceSimilarity(a: string, b: string): number {
  // Tokens are truncated to a 5-char prefix as a cheap stemmer, so
  // "regeneration"/"regen" and "killed"/"kills" count as the same concept.
  const tokens = (text: string) =>
    new Set(
      text
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((t) => t.length > 2 && !SIMILARITY_STOPWORDS.has(t))
        .map((t) => t.slice(0, 5))
    )
  const ta = tokens(a)
  const tb = tokens(b)
  if (ta.size === 0 || tb.size === 0) {
    return 0
  }
  let shared = 0
  for (const t of ta) {
    if (tb.has(t)) {
      shared++
    }
  }
  return shared / (ta.size + tb.size - shared)
}

const DUPLICATE_SIMILARITY = 0.55

// Record that a set of lessons rode along on a finished run, and what happened.
// Retire lessons with a sustained losing record: enough exposure to judge, and
// present in failing runs far more than passing ones.
const RETIRE_MIN_APPLIED = 8
const RETIRE_MAX_WIN_RATE = 0.25

export async function recordGuidanceOutcome(
  ids: Iterable<string>,
  outcome: 'done' | 'blocked'
): Promise<void> {
  for (const id of ids) {
    try {
      const raw: unknown = await Bun.file(itemPath(id)).json()
      const parsed = GuidanceRecordSchema.safeParse(raw)
      if (!parsed.success) {
        continue
      }
      const record = parsed.data
      record.applied += 1
      if (outcome === 'done') {
        record.wins += 1
      } else {
        record.losses += 1
      }
      record.updatedAt = new Date().toISOString()
      if (
        record.status === 'active' &&
        record.applied >= RETIRE_MIN_APPLIED &&
        record.wins / record.applied <= RETIRE_MAX_WIN_RATE
      ) {
        record.status = 'retired'
        log.warn(
          `guidance ${record.id} auto-retired: ${record.wins}/${record.applied} runs succeeded ` +
            'while it was applied'
        )
      }
      await writeRecord(record)
    } catch (err) {
      log.warn(
        `guidance outcome record failed for ${id}: ${err instanceof Error ? err.message : err}`
      )
    }
  }
}

export async function createGuidanceFromDistillation(
  ctx: WorkContext,
  input: {
    source: GuidanceSource
    text: string
    distillation: string
  }
): Promise<'created' | 'duplicate' | 'not-actionable' | 'invalid'> {
  const capture = parseGuidanceCapture(input.distillation)
  if (!capture) {
    return 'invalid'
  }
  if (!capture.actionable) {
    return 'not-actionable'
  }
  // Near-duplicate of an existing active lesson → refresh that record instead of
  // accumulating another copy of the same knowledge.
  const existing = (await loadGuidance()).find(
    (record) =>
      record.status === 'active' &&
      guidanceSimilarity(record.text, input.text) >= DUPLICATE_SIMILARITY
  )
  if (existing) {
    existing.updatedAt = new Date().toISOString()
    await writeRecord(existing)
    log.info(`guidance duplicate of ${existing.id} — refreshed instead of creating a new record`)
    return 'duplicate'
  }
  await createGuidanceRecord(ctx, {
    source: input.source,
    scope: scopeForContext(ctx, capture.scope),
    stages: capture.stages,
    text: input.text,
  })
  return 'created'
}
