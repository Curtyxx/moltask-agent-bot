/**
 * The monitor loop: fetch open asks, filter them, queue the new ones, and write a
 * work order per task for whichever agent (or human) does the actual work.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { filterTasks, summarize } from './filter.mjs'
import { enqueue, pruneSeen, saveState } from './state.mjs'

/**
 * One cycle. Network is injected so tests run without it.
 * @param {{api: import('./api.mjs').MoltaskApi, config: object, state: object,
 *   now?: () => Date, log?: (line: string) => void, persist?: boolean}} options
 * @returns {Promise<{fetched: number, suitable: number, added: number, queueSize: number, skipped: number}>}
 */
export async function runOnce(options) {
  const { api, config, state } = options
  const now = options.now ?? (() => new Date())
  const log = options.log ?? (() => {})
  const response = await api.listTasks({ status: 'open', limit: 100 })
  const tasks = Array.isArray(response?.tasks) ? response.tasks : []
  const suitable = filterTasks(tasks, config)
  let added = 0

  for (const { task, verdict } of suitable) {
    const result = enqueue(state, { task, verdict, at: now().toISOString() })
    if (!result.added) continue
    added++
    const path = writeWorkOrder(config, task, verdict)
    log(`+ queued ${verdict.bounty} MOLT · ${task.title ?? '(untitled)'} → ${path}`)
  }

  const pruned = pruneSeen(state, { now: now().getTime() })
  if (pruned > 0) log(`· pruned ${pruned} stale "seen" entries`)
  if (options.persist !== false) saveState(config.stateFile, state)

  return {
    fetched: tasks.length,
    suitable: suitable.length,
    added,
    queueSize: state.queue.length,
    skipped: tasks.length - suitable.length,
  }
}

/**
 * Repeated cycles with a fixed interval. Resolves when `maxCycles` is reached or
 * the abort signal fires; one failed cycle is logged and does not kill the loop.
 * @param {{api: object, config: object, state: object, maxCycles?: number,
 *   signal?: AbortSignal, log?: (line: string) => void, onCycle?: (cycle: object) => void,
 *   sleepImpl?: (ms: number, signal?: AbortSignal) => Promise<boolean>}} options
 */
export async function watch(options) {
  const { api, config, state } = options
  const log = options.log ?? (() => {})
  const sleepImpl = options.sleepImpl ?? sleep
  const maxCycles = options.maxCycles ?? Infinity
  let cycle = 0
  let failures = 0
  while (cycle < maxCycles && !options.signal?.aborted) {
    cycle++
    try {
      const result = await runOnce({ api, config, state, log, now: () => new Date() })
      log(`· cycle ${cycle}: fetched ${result.fetched}, suitable ${result.suitable}, new ${result.added}, queue ${result.queueSize}`)
      options.onCycle?.({ cycle, ...result })
    } catch (error) {
      failures++
      log(`! cycle ${cycle} failed: ${error.message}`)
    }
    if (cycle >= maxCycles) break
    if (!(await sleepImpl(config.pollSeconds * 1000, options.signal))) break
  }
  return { cycles: cycle, failures }
}

/** Markdown work order for the agent that will do the task. */
export function workOrderMarkdown(task, verdict, config) {
  const lines = [
    `# ${task.title ?? '(untitled ask)'}`,
    '',
    `- **Payout:** ${verdict.bounty} MOLT (you keep 97.5%)`,
    `- **Category:** ${task.category || 'unknown'}`,
    `- **Task key:** \`${verdict.key}\``,
    `- **API id:** ${task.id ?? '—'} · **on-chain id:** ${task.on_chain_task_id ?? '—'}`,
    `- **Deadline:** ${task.deadline ?? 'none stated'}`,
    `- **Score:** ${verdict.score} (${summarize(verdict)})`,
    '',
    '## Description',
    '',
    task.description?.trim() || '_No description provided._',
    '',
  ]
  if (Array.isArray(task.requirements) && task.requirements.length > 0) {
    lines.push('## Requirements', '', ...task.requirements.map(item => `- ${item}`), '')
  }
  if (Array.isArray(task.deliverables) && task.deliverables.length > 0) {
    lines.push('## Deliverables', '', ...task.deliverables.map(item => `- ${item}`), '')
  }
  lines.push(
    '## Submit',
    '',
    '```bash',
    `node bin/moltask-bot.mjs submit ${verdict.key} --message-file work.md --link <proof-url> --yes`,
    '```',
    '',
    `Payout address: \`${config.wallet || '<set MOLTASK_WALLET>'}\``,
    '',
  )
  return lines.join('\n')
}

/** Write one work order under `config.workOrderDir`; returns the path. */
export function writeWorkOrder(config, task, verdict) {
  mkdirSync(config.workOrderDir, { recursive: true })
  const safe = verdict.key.replace(/^0x/, '').slice(0, 16) || 'task'
  const path = join(config.workOrderDir, `${safe}.md`)
  writeFileSync(path, workOrderMarkdown(task, verdict, config), 'utf8')
  return path
}

function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve(false)
    const timer = setTimeout(() => resolve(true), ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      resolve(false)
    }, { once: true })
  })
}
