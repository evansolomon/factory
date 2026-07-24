import { dispatchWorktreesDir, loadContext, type WorkContext } from './config.ts'
import { readDispatchChain } from './dispatch-chain.ts'
import { isDelegatedTask, loadTasks } from './task.ts'

export type WorkstreamHop = {
  parentTaskId: string
  chainId: string
  unit: string
  position: number
  total: number
}

export type ActiveWorkstream = {
  source: WorkContext
  leaf: WorkContext
  hops: WorkstreamHop[]
}

export class WorkstreamResolutionError extends Error {
  override readonly name = 'WorkstreamResolutionError'
}

export function delegatedChainId(task: {
  meta: { dispatchChainId: string | null; note: string | null }
}): string | null {
  return task.meta.dispatchChainId ?? /\(([^()]+)\)$/.exec(task.meta.note ?? '')?.[1] ?? null
}

export async function resolveActiveWorkstream(source: WorkContext): Promise<ActiveWorkstream> {
  const hops: WorkstreamHop[] = []
  const seenRoots = new Set([source.root])
  let current = source

  while (!current.config.dispatch) {
    const parent = (await loadTasks(current)).find(isDelegatedTask)
    if (!parent) {
      break
    }
    const chainId = delegatedChainId(parent)
    if (!chainId) {
      break
    }
    const chain = await readDispatchChain(current.repoStateDir, chainId)
    if (!chain) {
      throw new WorkstreamResolutionError(
        `${breadcrumb(hops, parent.id)}: delegated chain ${chainId} is missing`
      )
    }
    if (!chain.currentUnit) {
      break
    }
    const index = chain.units.indexOf(chain.currentUnit)
    if (index === -1) {
      throw new WorkstreamResolutionError(
        `${breadcrumb(hops, parent.id)}: active unit ${chain.currentUnit} is not in chain ${chainId}`
      )
    }
    const childRoot = `${await dispatchWorktreesDir(current.root)}/${chain.currentUnit}`
    if (seenRoots.has(childRoot)) {
      throw new WorkstreamResolutionError(
        `${breadcrumb(hops, parent.id)}: delegated workstream cycle at ${chain.currentUnit}`
      )
    }
    let child: WorkContext
    try {
      child = await loadContext(childRoot)
    } catch {
      throw new WorkstreamResolutionError(
        `${breadcrumb(hops, parent.id)}: active unit ${chain.currentUnit} is unavailable`
      )
    }
    hops.push({
      parentTaskId: parent.id,
      chainId,
      unit: chain.currentUnit,
      position: index + 1,
      total: chain.units.length,
    })
    seenRoots.add(child.root)
    current = child
  }

  return { source, leaf: current, hops }
}

export function breadcrumb(hops: WorkstreamHop[], fallback = ''): string {
  const first = hops[0]?.parentTaskId ?? fallback
  const units = hops.map((hop) => `${hop.unit} (${hop.position}/${hop.total})`)
  return [first, ...units].filter(Boolean).join(' → ')
}
