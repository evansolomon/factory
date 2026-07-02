import { mkdir, readdir, rename } from 'node:fs/promises'
import { dirname } from 'node:path'
import { sessionsDir, type WorkContext } from './config.ts'
import {
  createGuidanceRecord,
  DUPLICATE_SIMILARITY,
  type GuidanceCapture,
  type GuidanceRecord,
  type GuidanceScope,
  type GuidanceSource,
  guidanceSimilarity,
  listGuidance,
  parseGuidanceCapture,
  scopeForContext,
} from './guidance.ts'
import { log } from './log.ts'

// Legacy repo guidance. LESSONS.md is human-curated, high-signal, and read into
// the plan/critique stages every iteration so existing users keep their current
// behavior. Structured learned lessons live under global factory state.
// LESSONS.candidates.md remains a machine-appended raw human-curation queue.
//
// Both live at the REPO level (repoStateDir, keyed by the main worktree), not
// per-worktree — so lessons accumulate across all the repo's (short-lived)
// worktrees instead of resetting each time you start a task on a new branch.

function lessonsPath(ctx: WorkContext): string {
  return `${ctx.repoStateDir}/LESSONS.md`
}

function candidatesPath(ctx: WorkContext): string {
  return `${ctx.repoStateDir}/LESSONS.candidates.md`
}

function candidatesArchivePath(ctx: WorkContext): string {
  return `${ctx.repoStateDir}/LESSONS.candidates.archive.md`
}

export async function readLessons(ctx: WorkContext): Promise<string | null> {
  try {
    const file = Bun.file(lessonsPath(ctx))
    if (!(await file.exists())) {
      return null
    }
    return (await file.text()).trim() || null
  } catch (err) {
    log.warn(`legacy lessons read failed: ${err instanceof Error ? err.message : err}`)
    return null
  }
}

export async function readCandidates(ctx: WorkContext): Promise<string | null> {
  try {
    const file = Bun.file(candidatesPath(ctx))
    if (!(await file.exists())) {
      return null
    }
    return (await file.text()).trim() || null
  } catch (err) {
    log.warn(`lesson candidates read failed: ${err instanceof Error ? err.message : err}`)
    return null
  }
}

const CANDIDATES_HEADER =
  '# Lesson candidates\n\n' +
  'Raw signals from blocks and questions. Curate the recurring ones into\n' +
  'LESSONS.md (which the planner reads every run); delete the noise.\n\n'

export type LessonCandidate = {
  rawLine: string
  ts: string | null
  signal: string
  kind: string
  taskId: string | null
  category: string | null
  lessonText: string
  artifact: LessonCandidateArtifact | null
}

export type LessonCandidateArtifact = {
  path: string
  text: string
  capture: GuidanceCapture | null
}

export type LessonCluster = {
  representative: LessonCandidate
  candidates: LessonCandidate[]
}

export type LessonPromotionProposal = {
  text: string
  capture: GuidanceCapture
  source: GuidanceSource
  candidates: LessonCandidate[]
  artifactPath: string
}

export type LessonCuratePlan = {
  candidates: LessonCandidate[]
  clusters: LessonCluster[]
  promotions: LessonPromotionProposal[]
  duplicates: LessonCluster[]
  noise: LessonCluster[]
}

export type LessonCurateApplyResult = {
  created: GuidanceRecord[]
  duplicates: LessonCluster[]
  drained: number
  archivePath: string | null
}

export async function appendCandidate(ctx: WorkContext, signal: string): Promise<void> {
  try {
    const path = candidatesPath(ctx)
    await mkdir(dirname(path), { recursive: true })
    const file = Bun.file(path)
    const existing = (await file.exists()) ? await file.text() : CANDIDATES_HEADER
    await Bun.write(path, `${existing}- ${new Date().toISOString()} · ${signal}\n`)
  } catch (err) {
    log.warn(`lesson candidate capture failed: ${err instanceof Error ? err.message : err}`)
  }
}

function splitSignal(signal: string): string[] {
  return signal
    .split(' · ')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
}

function parseCategory(text: string): { category: string | null; text: string } {
  const match = /^\[([^\]]+)\]\s*(.+)$/.exec(text)
  if (!match) {
    return { category: null, text }
  }
  return { category: match[1]?.toLowerCase() ?? null, text: match[2] ?? text }
}

function parseCandidateLine(line: string): Omit<LessonCandidate, 'artifact'> | null {
  const trimmed = line.trim()
  if (!trimmed.startsWith('- ')) {
    return null
  }

  const match = /^-\s+(\d{4}-\d{2}-\d{2}T[^·]+)\s+·\s+(.+)$/.exec(trimmed)
  const ts = match?.[1]?.trim() ?? null
  const signal = match?.[2]?.trim() ?? trimmed.slice(2).trim()
  if (!signal) {
    return null
  }

  const parts = splitSignal(signal)
  const kind = parts[0] ?? 'candidate'
  const taskId = parts[1] && !parts[1].startsWith('[') ? parts[1] : null
  const detail = parts.length >= 3 ? parts.slice(2).join(' · ') : signal
  const parsed = parseCategory(detail)
  const lessonText = parsed.text.trim()
  if (!lessonText) {
    return null
  }

  return {
    rawLine: trimmed,
    ts,
    signal,
    kind,
    taskId,
    category: parsed.category,
    lessonText,
  }
}

export function parseLessonCandidates(text: string | null): Omit<LessonCandidate, 'artifact'>[] {
  if (!text) {
    return []
  }
  const candidates: Omit<LessonCandidate, 'artifact'>[] = []
  for (const line of text.split('\n')) {
    const parsed = parseCandidateLine(line)
    if (parsed) {
      candidates.push(parsed)
    }
  }
  return candidates
}

async function readArtifact(path: string): Promise<string | null> {
  const file = Bun.file(path)
  if (!(await file.exists())) {
    return null
  }
  return (await file.text()).trim() || null
}

async function findCandidateArtifact(candidate: Omit<LessonCandidate, 'artifact'>) {
  if (!candidate.taskId) {
    return null
  }
  const names =
    candidate.kind === 'post-ship rework'
      ? ['harvest.md', 'postmortem.md']
      : ['postmortem.md', 'harvest.md']
  let sessions: string[] = []
  try {
    sessions = await readdir(sessionsDir())
  } catch {
    return null
  }
  for (const session of sessions) {
    for (const name of names) {
      const path = `${sessionsDir()}/${session}/tasks/${candidate.taskId}/${name}`
      const text = await readArtifact(path)
      if (text) {
        return { path, text, capture: parseGuidanceCapture(text) }
      }
    }
  }
  return null
}

async function loadCandidates(ctx: WorkContext): Promise<LessonCandidate[]> {
  const raw = parseLessonCandidates(await readCandidates(ctx))
  const candidates: LessonCandidate[] = []
  for (const candidate of raw) {
    candidates.push({ ...candidate, artifact: await findCandidateArtifact(candidate) })
  }
  return candidates
}

function clusterCandidates(candidates: LessonCandidate[]): LessonCluster[] {
  const clusters: LessonCluster[] = []
  for (const candidate of candidates) {
    const existing = clusters.find(
      (cluster) =>
        guidanceSimilarity(cluster.representative.lessonText, candidate.lessonText) >=
        DUPLICATE_SIMILARITY
    )
    if (existing) {
      existing.candidates.push(candidate)
    } else {
      clusters.push({ representative: candidate, candidates: [candidate] })
    }
  }
  return clusters
}

function sourceKind(kind: string): GuidanceSource['kind'] {
  return kind === 'correction' ? 'correction' : 'postmortem'
}

function sourceDetail(cluster: LessonCluster): string {
  const category = cluster.representative.category ? ` ${cluster.representative.category}` : ''
  const count = cluster.candidates.length
  return `curated ${count} ${cluster.representative.kind}${category} candidate${count === 1 ? '' : 's'}`
}

function proposalFromCluster(cluster: LessonCluster): LessonPromotionProposal | null {
  const candidateWithCapture = cluster.candidates.find(
    (candidate) => candidate.artifact?.capture?.actionable === true
  )
  const artifact = candidateWithCapture?.artifact
  const capture = artifact?.capture
  if (!candidateWithCapture || !artifact || !capture?.actionable) {
    return null
  }

  return {
    text: candidateWithCapture.lessonText,
    capture,
    source: {
      kind: sourceKind(candidateWithCapture.kind),
      taskId: candidateWithCapture.taskId,
      detail: sourceDetail(cluster),
    },
    candidates: cluster.candidates,
    artifactPath: artifact.path,
  }
}

function guidanceScope(ctx: WorkContext, capture: GuidanceCapture): GuidanceScope {
  return scopeForContext(ctx, capture.scope)
}

function hasDuplicateGuidance(records: GuidanceRecord[], text: string): boolean {
  return records.some(
    (record) =>
      record.status === 'active' && guidanceSimilarity(record.text, text) >= DUPLICATE_SIMILARITY
  )
}

export async function planLessonCuration(
  ctx: WorkContext,
  opts: { minClusterSize?: number } = {}
): Promise<LessonCuratePlan> {
  const minClusterSize = opts.minClusterSize ?? 2
  if (!Number.isInteger(minClusterSize) || minClusterSize < 1) {
    throw new Error('--min-cluster needs a positive integer')
  }

  const candidates = await loadCandidates(ctx)
  const clusters = clusterCandidates(candidates)
  const existing = await listGuidance(ctx)
  const promotions: LessonPromotionProposal[] = []
  const duplicates: LessonCluster[] = []
  const noise: LessonCluster[] = []

  for (const cluster of clusters) {
    if (cluster.candidates.length < minClusterSize) {
      noise.push(cluster)
      continue
    }
    const proposal = proposalFromCluster(cluster)
    if (!proposal) {
      noise.push(cluster)
      continue
    }
    if (hasDuplicateGuidance(existing, proposal.text)) {
      duplicates.push(cluster)
      continue
    }
    promotions.push(proposal)
  }

  return { candidates, clusters, promotions, duplicates, noise }
}

export function guidanceRecordsForCuration(
  ctx: WorkContext,
  proposals: LessonPromotionProposal[],
  now = new Date().toISOString()
): GuidanceRecord[] {
  return proposals.map((proposal, index) => ({
    id: `curate-${index + 1}`,
    createdAt: now,
    updatedAt: now,
    source: proposal.source,
    scope: guidanceScope(ctx, proposal.capture),
    stages: proposal.capture.stages,
    tags: [],
    text: proposal.text,
    rationale: null,
    status: 'active',
    deletedAt: null,
    applied: 0,
    wins: 0,
    losses: 0,
  }))
}

async function writeCandidatesFile(ctx: WorkContext, body: string): Promise<void> {
  const path = candidatesPath(ctx)
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`
  await Bun.write(tmp, body)
  await rename(tmp, path)
}

async function archiveCandidates(
  ctx: WorkContext,
  candidates: LessonCandidate[]
): Promise<string | null> {
  if (candidates.length === 0) {
    return null
  }
  const path = candidatesArchivePath(ctx)
  await mkdir(dirname(path), { recursive: true })
  const file = Bun.file(path)
  const existing = (await file.exists()) ? await file.text() : '# Curated lesson candidates\n\n'
  const archived = [
    existing.trimEnd(),
    '',
    `## ${new Date().toISOString()}`,
    '',
    ...candidates.map((candidate) => candidate.rawLine),
    '',
  ].join('\n')
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`
  await Bun.write(tmp, archived)
  await rename(tmp, path)
  return path
}

export async function applyLessonCuration(
  ctx: WorkContext,
  plan: LessonCuratePlan
): Promise<LessonCurateApplyResult> {
  const existing = await listGuidance(ctx)
  const created: GuidanceRecord[] = []
  const duplicates = [...plan.duplicates]
  for (const proposal of plan.promotions) {
    if (hasDuplicateGuidance(existing, proposal.text)) {
      const representative = proposal.candidates[0]
      if (representative) {
        duplicates.push({ representative, candidates: proposal.candidates })
      }
      continue
    }
    const record = await createGuidanceRecord(ctx, {
      source: proposal.source,
      scope: guidanceScope(ctx, proposal.capture),
      stages: proposal.capture.stages,
      text: proposal.text,
    })
    existing.push(record)
    created.push(record)
  }
  const archivePath = await archiveCandidates(ctx, plan.candidates)
  await writeCandidatesFile(ctx, CANDIDATES_HEADER)
  return { created, duplicates, drained: plan.candidates.length, archivePath }
}
