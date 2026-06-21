export type RunResult = { stdout: string; stderr: string; code: number }

// Run a command, feeding `stdin` and capturing stdout/stderr. We pass agent
// prompts on stdin rather than argv to avoid shell escaping and length limits.
// `streamTo`: tee stdout to that file as it arrives (flushed per chunk), so the
// activity log is live (`tail -f` mid-step) while still returning the full text.
export async function run(
  cmd: string[],
  opts: {
    cwd: string
    stdin?: string
    streamTo?: string
    // Full environment for the child (caller includes process.env if it wants it).
    env?: Record<string, string>
    // Kill the child after this many ms (used for best-effort hooks).
    timeout?: number
  }
): Promise<RunResult> {
  const proc = Bun.spawn(cmd, {
    cwd: opts.cwd,
    stdin: new TextEncoder().encode(opts.stdin ?? ''),
    stdout: 'pipe',
    stderr: 'pipe',
    ...(opts.env ? { env: opts.env } : {}),
    ...(opts.timeout ? { timeout: opts.timeout } : {}),
  })

  const stderrText = new Response(proc.stderr).text()
  let stdout = ''
  if (opts.streamTo) {
    const sink = Bun.file(opts.streamTo).writer()
    const decoder = new TextDecoder()
    for await (const chunk of proc.stdout) {
      sink.write(chunk)
      await sink.flush()
      stdout += decoder.decode(chunk, { stream: true })
    }
    stdout += decoder.decode()
    await sink.end()
  } else {
    stdout = await new Response(proc.stdout).text()
  }
  const stderr = await stderrText
  const code = await proc.exited

  return { stdout, stderr, code }
}
