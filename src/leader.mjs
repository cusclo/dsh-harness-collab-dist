import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promisify } from 'node:util'

const run = promisify(execFile)
const previewLimit = 20_000

export async function snapshot(cwd, signal) {
  const git = async (...args) => (await run('git', ['--no-optional-locks', ...args], {
    cwd, signal, timeout: 10_000, maxBuffer: 2_000_000,
  })).stdout
  const base = (await git('rev-parse', '--verify', 'HEAD')).trim()
  const status = await git('status', '--short', '--untracked-files=normal', '--', '.')
  const patch = await git('diff', '--no-ext-diff', '--no-textconv', '--no-color', base, '--', '.')
  return {
    cwd, base, status,
    diff: patch.slice(0, previewLimit),
    diffSha256: createHash('sha256').update(patch).digest('hex'),
    truncated: patch.length > previewLimit,
  }
}

export const name = 'collab-leader'
export const inject = ['systemPrompt', 'tools', 'workingDirectory', 'subprocess']

const instructions = `You are the DeepSeek leader of a local coding collaboration.
Use the request as the authority for work and the acceptance criteria. Ask only for decisions that block the work. For code change requests, follow this workflow:
1. Call collab_snapshot to record the starting tree. Delegate implementation to subagent_codex, including the complete task, working directory, scope, and test command. Keep the deliverable local. Tell the worker to leave changes uncommitted. Only Codex may edit the code. If a required worker fails, report the blocker after at most one retry. Do not substitute another worker.
2. Wait for that worker's completion before the next stage. If only waiting remains, end your turn; Harness will wake you when the worker settles. Do not poll or sleep. A start receipt is not completion.
3. Call collab_review_agy after implementation for an independent review of the actual diff. Ask for concrete findings and acceptance gaps. Do not ask the reviewer to invent defects.
4. For a valid finding, call subagent_codex again with the original task, current state and the specific review feedback. Wait for completion. Each delegation starts a fresh worker, so include all needed context.
5. Run the requested verification in the working directory, capture the final collab_snapshot, and report the actual diff and test result. Identify skipped or failed verification. Do not commit, push, publish, or write to remotes.
Use the worker return messages as evidence. Do not claim review, rework, or tests happened before their evidence exists.`

const snapshotOutput = {
  type: 'object',
  additionalProperties: false,
  required: ['cwd', 'base', 'status', 'diff', 'diffSha256', 'truncated'],
  properties: {
    cwd: { type: 'string' },
    base: { type: 'string' },
    status: { type: 'string' },
    diff: { type: 'string' },
    diffSha256: { type: 'string' },
    truncated: { type: 'boolean' },
  },
}

export async function reviewWithAgy(subprocess, cwd, focus, callerSignal) {
  const signal = AbortSignal.any([callerSignal, AbortSignal.timeout(135_000)])
  const before = await snapshot(cwd, signal)
  if (!before.diff) throw new Error('There is no tracked Git diff to review')
  const prompt = [
    'Review the supplied Git patch. Answer directly from the supplied text without calling tools, running commands, reading files, or creating a plan.',
    'Report actionable findings with file references, or say there are no findings. State any limits of the evidence.',
    `Review focus: ${focus}`,
    `Git base: ${before.base}\nDiff SHA-256: ${before.diffSha256}`,
    before.truncated ? 'This is a truncated patch preview. Limit findings to the supplied excerpt.' : 'Full tracked patch:',
    before.diff,
  ].join('\n\n')
  const child = subprocess.spawn({
    argv: [
      process.env.DSH_COLLAB_AGY_BIN || 'agy',
      '--mode', 'plan', '--sandbox', '--disable-slash-commands',
      '--model', process.env.DSH_COLLAB_AGY_MODEL || 'gemini-3.8-flash-medium',
      '--print-timeout', '120s', '--output-format', 'json', '--print', prompt,
    ],
    cwd,
    stdio: { stdin: 'ignore', stdout: { maxBytes: 512_000 }, stderr: { maxBytes: 4096 } },
    signal,
    graceMs: 3000,
  })
  const outcome = await child.done
  signal.throwIfAborted()
  const output = child.collected.stdout.readFrom(0)
  if (output.lossy) throw new Error('agy review output exceeded the capture limit')
  if (outcome.exitCode !== 0) throw new Error(`agy review exited with ${outcome.exitCode ?? outcome.signal}`)
  let result
  try { result = JSON.parse(output.text) }
  catch { throw new Error('agy did not return a JSON result') }
  if (result?.status !== 'SUCCESS' || typeof result.response !== 'string' || !result.response.trim()) {
    const status = /^[A-Z_]+$/.test(result?.status) ? result.status : 'UNKNOWN'
    throw new Error(`agy returned no successful review (status: ${status})`)
  }
  const after = await snapshot(cwd, signal)
  if (after.base !== before.base || after.diffSha256 !== before.diffSha256 || after.status !== before.status) {
    throw new Error('The Git snapshot changed during review. Recheck the workspace before accepting the review.')
  }
  return { review: result.response.trim(), diffSha256: before.diffSha256 }
}

const render = (_args, value) => [{ type: 'text', text: JSON.stringify(value) }]

export function apply(ctx) {
  const workingDirectory = exec => {
    if (!exec.agent) throw new Error('A collaboration session is required')
    return ctx.workingDirectory.get(exec.agent.session)
  }
  ctx.systemPrompt.section({ name, order: 60, interpolate: false, text: instructions })
  ctx.tools.register({
    name: 'collab_snapshot',
    description: 'Read the Git base, status and tracked diff for the current directory. Status also shows untracked files, which are outside the diff.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: snapshotOutput,
      render,
    },
    async execute(_args, exec) {
      return snapshot(workingDirectory(exec), exec.signal)
    },
  })
  ctx.tools.register({
    name: 'collab_review_agy',
    description: 'Run an independent Antigravity CLI review of the current Git diff in plan mode and wait for the result.',
    parameters: {
      type: 'object',
      properties: { focus: { type: 'string', description: 'Original goal and what the reviewer should verify.' } },
      required: ['focus'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: { review: { type: 'string' }, diffSha256: { type: 'string' } },
        required: ['review', 'diffSha256'],
        additionalProperties: false,
      },
      render,
    },
    async execute({ focus }, exec) {
      return reviewWithAgy(ctx.subprocess, workingDirectory(exec), focus, exec.signal)
    },
  })
}
