import { spawn } from 'child_process'

export interface ClaudeResponse {
  content: string
  tokenUsage?: number
}

export async function callClaude(
  message: string,
  systemPrompt: string,
  workDir?: string,
): Promise<ClaudeResponse> {
  const args = [
    '-p', message,
    '--output-format', 'json',
    '--permission-mode', 'bypassPermissions',
    '--model', 'sonnet',
  ]

  if (systemPrompt) {
    args.push('--append-system-prompt', systemPrompt)
  }

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      proc.kill('SIGTERM')
      reject(new Error('Claude CLI timeout (120s)'))
    }, 120_000)

    const proc = spawn('claude', args, {
      env: { ...process.env },
      cwd: workDir ?? process.cwd(),
    })

    let stdout = ''
    let stderr = ''

    proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })

    proc.on('close', (code) => {
      clearTimeout(timeout)
      if (code !== 0) {
        return reject(new Error(`Claude CLI exited with code ${code}: ${stderr}`))
      }
      try {
        const parsed = JSON.parse(stdout)
        resolve({
          content: parsed.result ?? parsed.content ?? stdout.trim(),
          tokenUsage: parsed.usage?.total_tokens,
        })
      } catch {
        resolve({ content: stdout.trim() })
      }
    })

    proc.on('error', (err) => {
      clearTimeout(timeout)
      reject(err)
    })
  })
}
