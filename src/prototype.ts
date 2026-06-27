import { mkdir } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import type { Task } from './task.ts'

export const PROTOTYPE_SUMMARY = 'prototype.md'
export const PROTOTYPE_RAW = 'prototype.raw.md'
export const PROTOTYPE_META = 'prototype.meta.json'
export const PROTOTYPE_ARTIFACT_DIR = 'prototype-artifacts'

const ARTIFACT_CONTEXT_LIMIT = 4000
const SUMMARY_CONTEXT_LIMIT = 3000

const PrototypeDecisionSchema = z.enum(['created', 'skipped', 'fallback'])

const PrototypeManifestSchema = z
  .object({
    decision: PrototypeDecisionSchema,
    primaryArtifact: z.string().nullable(),
    requestedFilename: z.string().nullable(),
    reason: z.string(),
  })
  .refine(
    (manifest) =>
      manifest.primaryArtifact === null || isSafePrototypePrimaryArtifact(manifest.primaryArtifact),
    { message: 'invalid prototype primary artifact path' }
  )

export type PrototypeManifest = z.infer<typeof PrototypeManifestSchema>

export type ParsedPrototype =
  | {
      ok: true
      decision: 'created'
      artifactName: string
      requestedFilename: string
      reason: string
      content: string
    }
  | {
      ok: true
      decision: 'skipped'
      requestedFilename: string | null
      reason: string
    }
  | {
      ok: false
      requestedFilename: string | null
      reason: string
    }

export type PrototypeWriteResult =
  | { decision: 'created'; artifact: string; url: string; reason: string }
  | { decision: 'skipped'; reason: string }
  | { decision: 'fallback'; reason: string }

function markerValue(text: string, marker: string): string | null {
  const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`^${escaped}:\\s*(.+)$`, 'im').exec(text)?.[1]?.trim() ?? null
}

function stripOneLineBreak(text: string): string {
  if (text.startsWith('\r\n')) {
    return text.slice(2)
  }
  if (text.startsWith('\n')) {
    return text.slice(1)
  }
  return text
}

function artifactBody(text: string): string | null {
  const begin = /^--- BEGIN ARTIFACT ---\r?$/im.exec(text)
  if (!begin) {
    return null
  }
  const afterBegin = text.slice(begin.index + begin[0].length)
  const bodyAndEnd = stripOneLineBreak(afterBegin)
  const end = /^--- END ARTIFACT ---\r?$/im.exec(bodyAndEnd)
  if (!end) {
    return null
  }
  return bodyAndEnd.slice(0, end.index).replace(/\r?\n$/, '')
}

export function isSafePrototypeArtifactName(name: string): boolean {
  const trimmed = name.trim()
  return (
    trimmed.length > 0 &&
    trimmed.toLowerCase() !== 'none' &&
    !trimmed.includes('/') &&
    !trimmed.includes('\\') &&
    !trimmed.includes('..') &&
    !hasControlCharacter(trimmed) &&
    !isAbsolute(trimmed) &&
    !/^[A-Za-z]:/.test(trimmed)
  )
}

function isSafePrototypePrimaryArtifact(path: string): boolean {
  const prefix = `${PROTOTYPE_ARTIFACT_DIR}/`
  if (!path.startsWith(prefix)) {
    return false
  }
  return isSafePrototypeArtifactName(path.slice(prefix.length))
}

function hasControlCharacter(text: string): boolean {
  for (const char of text) {
    const code = char.charCodeAt(0)
    if (code < 32 || code === 127) {
      return true
    }
  }
  return false
}

export function parsePrototypeOutput(text: string): ParsedPrototype {
  const decisionRaw = markerValue(text, 'PROTOTYPE')
  const requestedRaw = markerValue(text, 'ARTIFACT')
  const reason = markerValue(text, 'REASON')
  const requestedFilename =
    requestedRaw && requestedRaw.toLowerCase() !== 'none' ? requestedRaw : null

  if (!decisionRaw || !reason) {
    return { ok: false, requestedFilename, reason: 'missing required prototype markers' }
  }

  const decision = decisionRaw.toUpperCase()
  if (decision === 'NO') {
    return { ok: true, decision: 'skipped', requestedFilename, reason }
  }
  if (decision !== 'YES') {
    return { ok: false, requestedFilename, reason: `invalid PROTOTYPE value: ${decisionRaw}` }
  }
  if (!requestedFilename || !isSafePrototypeArtifactName(requestedFilename)) {
    return { ok: false, requestedFilename, reason: 'unsafe or missing prototype artifact name' }
  }
  const content = artifactBody(text)
  if (!content || content.trim().length === 0) {
    return { ok: false, requestedFilename, reason: 'missing prototype artifact content' }
  }
  return {
    ok: true,
    decision: 'created',
    artifactName: requestedFilename,
    requestedFilename,
    reason,
    content,
  }
}

function summaryForCreated(manifest: PrototypeManifest): string {
  const lines = ['# Prototype', '', 'Decision: created', `Reason: ${manifest.reason}`]
  if (manifest.primaryArtifact) {
    lines.push(`Primary artifact: ${manifest.primaryArtifact}`)
  }
  if (manifest.requestedFilename) {
    lines.push(`Requested filename: ${manifest.requestedFilename}`)
  }
  return `${lines.join('\n')}\n`
}

function summaryForSkipped(manifest: PrototypeManifest): string {
  return ['# Prototype', '', 'Decision: skipped', `Reason: ${manifest.reason}`, ''].join('\n')
}

async function writeManifest(task: Task, manifest: PrototypeManifest): Promise<void> {
  await Bun.write(`${task.dir}/${PROTOTYPE_META}`, `${JSON.stringify(manifest, null, 2)}\n`)
}

export async function writePrototypeFallback(
  task: Task,
  rawOutput: string,
  reason: string,
  requestedFilename: string | null = null
): Promise<PrototypeWriteResult> {
  const manifest: PrototypeManifest = {
    decision: 'fallback',
    primaryArtifact: null,
    requestedFilename,
    reason,
  }
  await Bun.write(`${task.dir}/${PROTOTYPE_SUMMARY}`, rawOutput.trim() ? rawOutput : reason)
  await writeManifest(task, manifest)
  return { decision: 'fallback', reason }
}

export async function writePrototypeOutput(
  task: Task,
  output: string
): Promise<PrototypeWriteResult> {
  const parsed = parsePrototypeOutput(output)
  if (!parsed.ok) {
    return writePrototypeFallback(task, output, parsed.reason, parsed.requestedFilename)
  }

  if (parsed.decision === 'skipped') {
    const manifest: PrototypeManifest = {
      decision: 'skipped',
      primaryArtifact: null,
      requestedFilename: parsed.requestedFilename,
      reason: parsed.reason,
    }
    await Bun.write(`${task.dir}/${PROTOTYPE_SUMMARY}`, summaryForSkipped(manifest))
    await writeManifest(task, manifest)
    return { decision: 'skipped', reason: parsed.reason }
  }

  const relativeArtifact = `${PROTOTYPE_ARTIFACT_DIR}/${parsed.artifactName}`
  const artifactPath = resolve(task.dir, relativeArtifact)
  await mkdir(resolve(task.dir, PROTOTYPE_ARTIFACT_DIR), { recursive: true })
  await Bun.write(artifactPath, parsed.content)
  const manifest: PrototypeManifest = {
    decision: 'created',
    primaryArtifact: relativeArtifact,
    requestedFilename: parsed.requestedFilename,
    reason: parsed.reason,
  }
  await Bun.write(`${task.dir}/${PROTOTYPE_SUMMARY}`, summaryForCreated(manifest))
  await writeManifest(task, manifest)
  return {
    decision: 'created',
    artifact: artifactPath,
    url: pathToFileURL(artifactPath).href,
    reason: parsed.reason,
  }
}

export async function readPrototypeManifest(task: Task): Promise<PrototypeManifest | null> {
  const file = Bun.file(`${task.dir}/${PROTOTYPE_META}`)
  if (!(await file.exists())) {
    return null
  }
  try {
    const parsed = PrototypeManifestSchema.safeParse(await file.json())
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

function clip(text: string, limit: number): string {
  if (text.length <= limit) {
    return text
  }
  return `${text.slice(0, limit)}\n[truncated after ${limit} chars]`
}

export async function prototypePrimaryArtifactPath(task: Task): Promise<string | null> {
  const manifest = await readPrototypeManifest(task)
  if (!manifest?.primaryArtifact) {
    return null
  }
  const file = Bun.file(resolve(task.dir, manifest.primaryArtifact))
  return (await file.exists()) ? manifest.primaryArtifact : null
}

export async function prototypePrimaryArtifactUrl(task: Task): Promise<string | null> {
  const relative = await prototypePrimaryArtifactPath(task)
  return relative ? pathToFileURL(resolve(task.dir, relative)).href : null
}

export async function prototypeContext(
  task: Task,
  opts: { includeArtifactContent?: boolean; summaryLimit?: number; artifactLimit?: number } = {}
): Promise<string | null> {
  const manifest = await readPrototypeManifest(task)
  const summaryFile = Bun.file(`${task.dir}/${PROTOTYPE_SUMMARY}`)
  const summary = (await summaryFile.exists()) ? (await summaryFile.text()).trim() : null
  if (!manifest && !summary) {
    return null
  }

  const lines = ['## Prototype context']
  if (manifest) {
    lines.push(`Decision: ${manifest.decision}`)
    lines.push(`Reason: ${manifest.reason}`)
    if (manifest.primaryArtifact) {
      lines.push(`Primary artifact: ${manifest.primaryArtifact}`)
      lines.push(
        `Primary artifact URL: ${pathToFileURL(resolve(task.dir, manifest.primaryArtifact)).href}`
      )
    }
  }
  if (summary) {
    lines.push(
      '',
      '### Prototype summary',
      clip(summary, opts.summaryLimit ?? SUMMARY_CONTEXT_LIMIT)
    )
  }

  if (opts.includeArtifactContent !== false && manifest?.primaryArtifact) {
    const artifact = Bun.file(resolve(task.dir, manifest.primaryArtifact))
    if (await artifact.exists()) {
      lines.push(
        '',
        '### Primary prototype artifact content',
        clip(await artifact.text(), opts.artifactLimit ?? ARTIFACT_CONTEXT_LIMIT)
      )
    }
  }

  return lines.join('\n')
}
