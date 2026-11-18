/**
 * Local state: what the bot has seen, queued, submitted, and earned.
 * One small JSON file, written atomically, so a crash never leaves half a queue.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export const STATE_VERSION = 1

const nowIso = () => new Date().toISOString()

/** @returns {object} a fresh state document */
export function emptyState(wallet = '') {
  const at = nowIso()
  return {
    version: STATE_VERSION,
    wallet,
    createdAt: at,
    updatedAt: at,
    /** taskKey -> { firstSeenAt, title } — dedupe and "already looked at" bookkeeping. */
    seen: {},
    /** Unfinished work orders, best first. */
    queue: [],
    /** Every submission this bot made. */
    submissions: [],
    /** Confirmed payouts. */
    earnings: [],
  }
}

/**
 * Read state, falling back to an empty document. A corrupt file is reported
 * through `warnings` instead of crashing a long-running watcher.
 * @param {string} filePath
 * @param {{readFile?: (path: string) => string, wallet?: string}} [options]
 * @returns {{state: object, warnings: string[]}}
 */
export function loadState(filePath, options = {}) {
  const readFile = options.readFile ?? (path => readFileSync(path, 'utf8'))
  const warnings = []
  let text
  try {
    text = readFile(filePath)
  } catch (error) {
    if (error.code !== 'ENOENT') warnings.push(`state file ${filePath}: ${error.message}`)
    return { state: emptyState(options.wallet ?? ''), warnings }
  }
  try {
    const parsed = JSON.parse(text)
    const state = { ...emptyState(options.wallet ?? ''), ...parsed }
    if (!Array.isArray(state.queue)) state.queue = []
    if (!Array.isArray(state.submissions)) state.submissions = []
    if (!Array.isArray(state.earnings)) state.earnings = []
    if (typeof state.seen !== 'object' || state.seen === null) state.seen = {}
    return { state, warnings }
  } catch (error) {
    warnings.push(`state file ${filePath} is not JSON (${error.message}); starting empty`)
    return { state: emptyState(options.wallet ?? ''), warnings }
  }
}

/**
 * Write state atomically: temp file in the same directory, then rename.
 * @param {string} filePath
 * @param {object} state
 */
export function saveState(filePath, state) {
  state.updatedAt = nowIso()
  mkdirSync(dirname(filePath), { recursive: true })
  const temp = `${filePath}.${process.pid}.tmp`
  writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  renameSync(temp, filePath)
}

/**
 * Drop `seen` entries older than a window so the file does not grow forever.
 * @param {object} state
 * @param {{days?: number, now?: number}} [options]
 * @returns {number} how many entries were pruned
 */
export function pruneSeen(state, options = {}) {
  const days = options.days ?? 30
  const cutoff = (options.now ?? Date.now()) - days * 24 * 60 * 60 * 1000
  let pruned = 0
  for (const [key, entry] of Object.entries(state.seen)) {
    const at = Date.parse(entry?.firstSeenAt ?? '')
    if (Number.isFinite(at) && at < cutoff) {
      delete state.seen[key]
      pruned++
    }
  }
  return pruned
}

/**
 * Add a task to the queue unless it was already seen. This is the closest thing
 * to "claiming" on MolTask: the platform has no claim endpoint, so picking a task
 * is a local reservation plus a generated work order.
 * @param {object} state
 * @param {{task: object, verdict: object, at?: string}} input
 * @returns {{added: boolean, entry: object | null, reason?: string}}
 */
export function enqueue(state, input) {
  const { task, verdict } = input
  const at = input.at ?? nowIso()
  const key = verdict.key
  if (!key) return { added: false, entry: null, reason: 'task has no stable id' }
  if (state.seen[key]) {
    return { added: false, entry: state.queue.find(item => item.key === key) ?? null, reason: 'already seen' }
  }
  state.seen[key] = { firstSeenAt: at, title: task.title ?? '' }
  const entry = {
    key,
    id: task.id ?? null,
    onChainTaskId: task.on_chain_task_id ?? null,
    title: task.title ?? '',
    category: task.category ?? '',
    bounty: verdict.bounty,
    score: verdict.score,
    status: 'queued',
    queuedAt: at,
  }
  state.queue.push(entry)
  state.queue.sort((a, b) => b.score - a.score)
  return { added: true, entry }
}

/**
 * Record a submission and move its queue entry out of the queue.
 * @param {object} state
 * @param {{key: string, taskId: string, at?: string, linkUrl?: string, message?: string}} input
 */
export function markSubmitted(state, input) {
  const at = input.at ?? nowIso()
  const submission = {
    key: input.key,
    taskId: input.taskId,
    submittedAt: at,
    linkUrl: input.linkUrl ?? null,
    messagePreview: (input.message ?? '').slice(0, 140),
    status: 'pending-approval',
  }
  state.submissions.push(submission)
  state.queue = state.queue.filter(item => item.key !== input.key)
  return submission
}

/**
 * Record a payout. Amount is in MOLT.
 * @param {object} state
 * @param {{amount: number, key?: string, note?: string, at?: string}} input
 */
export function recordEarning(state, input) {
  const earning = { amount: Number(input.amount), key: input.key ?? null, note: input.note ?? '', at: input.at ?? nowIso() }
  state.earnings.push(earning)
  return earning
}

/** Totals for the terminal and the README demo. */
export function totals(state) {
  const earned = state.earnings.reduce((sum, item) => sum + (Number(item.amount) || 0), 0)
  return {
    queued: state.queue.length,
    submitted: state.submissions.length,
    pending: state.queue.filter(item => item.status === 'queued').length,
    earned: Math.round(earned * 1000) / 1000,
  }
}
