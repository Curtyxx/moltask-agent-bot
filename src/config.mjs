/**
 * Configuration: environment variables, an optional JSON file, and hard defaults.
 * Nothing here talks to the network — config is pure and unit-testable.
 */

/** Defaults chosen so a freshly cloned bot does nothing destructive. */
export const DEFAULTS = {
  apiBase: 'https://www.moltask.com/api',
  /** Wallet address that receives payouts. Empty means "discovery only". */
  wallet: '',
  /** Poll interval; the public API allows ~60 GET/min, so anything under 5s is refused. */
  pollSeconds: 120,
  /** Category allowlist; empty means "every category". */
  categories: [],
  minBounty: 0,
  maxBounty: null,
  /** Any of these in title/description makes a task unsuitable. */
  excludeKeywords: [],
  /** When non-empty, a task must contain at least one of these to be suitable. */
  keywords: [],
  /** Where queue, submissions and earnings live. */
  stateFile: './data/state.json',
  /** Where generated work orders are written. */
  workOrderDir: './data/work-orders',
  /** Never true by default: the bot queues work, a human or agent decides to submit. */
  autoSubmit: false,
  requestTimeoutMs: 15000,
  retries: 2,
}

const WALLET_RE = /^0x[0-9a-fA-F]{40}$/

/**
 * Read a config from process env plus an optional JSON file path.
 * @param {Record<string, string | undefined>} [env]
 * @param {{filePath?: string, readFile?: (path: string) => string}} [options]
 * @returns {typeof DEFAULTS & {warnings: string[]}}
 */
export function loadConfig(env = process.env, options = {}) {
  const warnings = []
  let file = {}
  if (options.filePath && options.readFile) {
    try {
      file = JSON.parse(options.readFile(options.filePath))
    } catch (error) {
      // A missing config file is the normal case for a fresh clone: stay quiet.
      if (error?.code !== 'ENOENT') warnings.push(`config file ${options.filePath} ignored: ${error.message}`)
    }
  }

  const pick = (envName, fileKey, fallback) => {
    if (env[envName] !== undefined && env[envName] !== '') return env[envName]
    if (file[fileKey] !== undefined) return file[fileKey]
    return fallback
  }

  const splitList = (value) => {
    if (Array.isArray(value)) return value.map(String).map(s => s.trim()).filter(Boolean)
    if (typeof value !== 'string' || value.trim() === '') return []
    return value.split(',').map(s => s.trim()).filter(Boolean)
  }

  const config = {
    ...DEFAULTS,
    apiBase: String(pick('MOLTASK_API_BASE', 'apiBase', DEFAULTS.apiBase)).replace(/\/+$/, ''),
    wallet: String(pick('MOLTASK_WALLET', 'wallet', DEFAULTS.wallet)).trim(),
    pollSeconds: Number(pick('MOLTASK_POLL_SECONDS', 'pollSeconds', DEFAULTS.pollSeconds)),
    categories: splitList(pick('MOLTASK_CATEGORIES', 'categories', DEFAULTS.categories)),
    keywords: splitList(pick('MOLTASK_KEYWORDS', 'keywords', DEFAULTS.keywords)),
    excludeKeywords: splitList(pick('MOLTASK_EXCLUDE', 'excludeKeywords', DEFAULTS.excludeKeywords)),
    minBounty: Number(pick('MOLTASK_MIN_BOUNTY', 'minBounty', DEFAULTS.minBounty)),
    maxBounty: pick('MOLTASK_MAX_BOUNTY', 'maxBounty', DEFAULTS.maxBounty) === null
      ? null
      : Number(pick('MOLTASK_MAX_BOUNTY', 'maxBounty', DEFAULTS.maxBounty)),
    stateFile: String(pick('MOLTASK_STATE_FILE', 'stateFile', DEFAULTS.stateFile)),
    workOrderDir: String(pick('MOLTASK_WORK_ORDER_DIR', 'workOrderDir', DEFAULTS.workOrderDir)),
    autoSubmit: pick('MOLTASK_AUTO_SUBMIT', 'autoSubmit', DEFAULTS.autoSubmit) === true
      || pick('MOLTASK_AUTO_SUBMIT', 'autoSubmit', '') === 'true',
    warnings,
  }

  if (config.pollSeconds < 5) {
    warnings.push(`pollSeconds ${config.pollSeconds} is below the 5s floor; using 5s`)
    config.pollSeconds = 5
  }
  if (!Number.isFinite(config.minBounty) || config.minBounty < 0) {
    warnings.push('minBounty is not a non-negative number; using 0')
    config.minBounty = 0
  }
  if (!WALLET_RE.test(config.wallet)) {
    warnings.push('wallet is missing or not a 0x-prefixed 40-hex Base address — discovery still works, submitting will refuse')
  }
  return config
}

/** True when the configured wallet can receive a MolTask payout. */
export function hasWallet(config) {
  return WALLET_RE.test(config.wallet)
}
