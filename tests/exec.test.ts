import { describe, expect, test } from 'bun:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { spawnDetached } from '../src/exec.ts'

function processGroupId(pid: number): string {
  const result = Bun.spawnSync(['ps', '-o', 'pgid=', '-p', String(pid)])
  if (result.exitCode !== 0) {
    throw new Error(`could not inspect process group for pid ${pid}`)
  }
  return result.stdout.toString().trim()
}

describe('spawnDetached', () => {
  test('creates an independent process session that can outlive the caller', async () => {
    const dir = await mkdtemp(`${tmpdir()}/factory-detached-`)
    const pid = await spawnDetached(['/bin/sleep', '30'], {
      cwd: dir,
      logFile: `${dir}/child.log`,
      env: { PATH: process.env['PATH'] ?? '' },
    })

    try {
      expect(processGroupId(pid)).toBe(String(pid))
      expect(processGroupId(pid)).not.toBe(processGroupId(process.pid))
    } finally {
      process.kill(pid, 'SIGTERM')
    }
  })
})
