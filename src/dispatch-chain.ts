import { randomUUID } from 'node:crypto'
import { mkdir, rename } from 'node:fs/promises'
import { z } from 'zod'

const DispatchChainSchema = z.object({
  id: z.string(),
  parentTaskId: z.string(),
  units: z.array(z.string()),
  currentUnit: z.string().nullable(),
  status: z.enum(['running', 'done', 'blocked', 'needs-input']),
  reason: z.string().nullable(),
  updatedAt: z.string(),
})

export type DispatchChain = z.infer<typeof DispatchChainSchema>

function chainPath(repoStateDir: string, chainId: string): string {
  return `${repoStateDir}/chains/${chainId}.json`
}

async function writeChain(repoStateDir: string, chain: DispatchChain): Promise<void> {
  const dir = `${repoStateDir}/chains`
  await mkdir(dir, { recursive: true })
  const path = chainPath(repoStateDir, chain.id)
  const temp = `${path}.${randomUUID()}.tmp`
  await Bun.write(temp, `${JSON.stringify(chain, null, 2)}\n`)
  await rename(temp, path)
}

export async function createDispatchChain(
  repoStateDir: string,
  input: { id: string; parentTaskId: string; units: string[] }
): Promise<DispatchChain> {
  const chain: DispatchChain = {
    ...input,
    currentUnit: null,
    status: 'running',
    reason: null,
    updatedAt: new Date().toISOString(),
  }
  await writeChain(repoStateDir, chain)
  return chain
}

export async function readDispatchChain(
  repoStateDir: string,
  chainId: string
): Promise<DispatchChain | null> {
  const file = Bun.file(chainPath(repoStateDir, chainId))
  if (!(await file.exists())) {
    return null
  }
  try {
    const parsed = DispatchChainSchema.safeParse(await file.json())
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

export async function updateDispatchChain(
  repoStateDir: string,
  chainId: string,
  patch: Partial<Pick<DispatchChain, 'currentUnit' | 'status' | 'reason'>>
): Promise<DispatchChain | null> {
  const chain = await readDispatchChain(repoStateDir, chainId)
  if (!chain) {
    return null
  }
  const next = {
    ...chain,
    ...patch,
    updatedAt: new Date().toISOString(),
  }
  await writeChain(repoStateDir, next)
  return next
}
