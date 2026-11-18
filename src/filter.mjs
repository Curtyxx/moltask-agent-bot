/**
 * Task suitability: which open asks can this agent realistically complete?
 * Pure functions, so the scoring rules are unit-tested without the network.
 */

/** MolTask's own category vocabulary. */
export const CATEGORIES = ['coding', 'research', 'writing', 'data', 'design', 'marketing', 'automation', 'testing', 'other']

/**
 * @typedef {{id?: string, on_chain_task_id?: string, task_hash?: string, title?: string, description?: string,
 *   category?: string, bounty_amount?: string | number, requirements?: string[], deliverables?: string[],
 *   on_chain_status?: number, deadline?: string | null}} Task
 * @typedef {{suitable: boolean, score: number, reasons: string[], key: string, bounty: number}} Verdict
 */

/** Stable identity for a task across API and on-chain ids. */
export function taskKey(task) {
  return task.on_chain_task_id || task.id || task.task_hash || ''
}

/** MolTask bounty amounts are MOLT strings; empty means the metadata is incomplete. */
export function bountyOf(task) {
  const value = Number(task.bounty_amount)
  return Number.isFinite(value) ? value : 0
}

/**
 * Decide whether one task is worth queueing, and explain why.
 * @param {Task} task
 * @param {ReturnType<typeof import('./config.mjs').loadConfig>} config
 * @returns {Verdict}
 */
export function scoreTask(task, config) {
  const reasons = []
  const key = taskKey(task)
  const bounty = bountyOf(task)
  const text = `${task.title ?? ''}\n${task.description ?? ''}`.toLowerCase()

  if (!key) reasons.push('no id: cannot be submitted or tracked')
  if (!task.title) reasons.push('no title: metadata is incomplete')

  if (config.categories.length > 0) {
    const category = (task.category ?? '').toLowerCase()
    if (!config.categories.includes(category)) reasons.push(`category "${category || 'unknown'}" is outside the allowlist`)
  }

  if (bounty <= 0) reasons.push('bounty is missing: the ask looks like an unfunded or metadata-only row')
  if (bounty > 0 && bounty < config.minBounty) reasons.push(`bounty ${bounty} is below the ${config.minBounty} MOLT floor`)
  if (bounty > 0 && config.maxBounty !== null && bounty > config.maxBounty) {
    reasons.push(`bounty ${bounty} is above the ${config.maxBounty} MOLT ceiling`)
  }

  for (const keyword of config.keywords) {
    if (!text.includes(keyword.toLowerCase())) {
      reasons.push(`does not mention any wanted keyword ("${keyword}" missing)`)
    }
  }

  for (const blocked of config.excludeKeywords) {
    if (text.includes(blocked.toLowerCase())) reasons.push(`contains excluded keyword "${blocked}"`)
  }

  // A task with neither requirements nor deliverables is usually a one-liner that
  // hides the real acceptance criteria; keep it, but rank it lower.
  let score = Math.min(bounty, 100000) / 1000
  if (Array.isArray(task.requirements) && task.requirements.length > 0) score += 3
  if (Array.isArray(task.deliverables) && task.deliverables.length > 0) score += 2
  if (task.description && task.description.length > 200) score += 1
  if ((task.category ?? '').toLowerCase() === 'automation') score += 0.5
  score += reasons.length === 0 ? 1 : -reasons.length

  return { suitable: reasons.length === 0, score: Math.round(score * 100) / 100, reasons, key, bounty }
}

/**
 * Filter and rank a task list; unsuitable tasks are dropped, the rest are sorted
 * by score (highest first) so the queue surface shows the best work first.
 * @param {Task[]} tasks
 * @param {ReturnType<typeof import('./config.mjs').loadConfig>} config
 */
export function filterTasks(tasks, config) {
  return tasks
    .map(task => ({ task, verdict: scoreTask(task, config) }))
    .filter(entry => entry.verdict.suitable)
    .sort((a, b) => b.verdict.score - a.verdict.score)
}

/** Human-readable summary used by `watch` and the demo. */
export function summarize(verdict) {
  return `${verdict.bounty} MOLT · score ${verdict.score}`
}
