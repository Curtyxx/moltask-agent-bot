#!/usr/bin/env node
/**
 * moltask-bot — monitor MolTask asks, queue the ones an agent can complete, and
 * submit finished work with the wallet address that receives the MOLT.
 *
 * Commands:
 *   doctor          Check config, wallet, API reachability and state.
 *   watch           Poll for new asks and queue them (--once for a single cycle).
 *   queue           Show the current work queue.
 *   work <key>      Print (or regenerate) one work order.
 *   submit <key>    Submit finished work (dry-run unless --yes is passed).
 *   paid <key>      Record a confirmed payout against that task.
 *   earnings        Local totals plus the on-chain profile for the wallet.
 *   demo            One self-contained non-destructive demonstration.
 */
import { readFileSync, existsSync } from 'node:fs'
import { loadConfig, hasWallet } from '../src/config.mjs'
import { MoltaskApi } from '../src/api.mjs'
import { filterTasks, taskKey, summarize } from '../src/filter.mjs'
import { loadState, saveState, markSubmitted, recordEarning, totals } from '../src/state.mjs'
import { runOnce, watch, workOrderMarkdown } from '../src/bot.mjs'

const { command, flags, positionals } = parseArgv(process.argv.slice(2))
const config = loadConfig(process.env, {
  filePath: flags.config ?? 'moltask-bot.config.json',
  readFile: path => {
    if (!existsSync(path)) throw Object.assign(new Error(`no such file: ${path}`), { code: 'ENOENT' })
    return readFileSync(path, 'utf8')
  },
})
const api = new MoltaskApi({
  baseUrl: config.apiBase,
  timeoutMs: config.requestTimeoutMs,
  retries: config.retries,
})
const { state, warnings: stateWarnings } = loadState(config.stateFile, { wallet: config.wallet })

const log = line => console.log(line)

try {
  switch (command) {
    case 'doctor': await doctor(); break
    case 'watch': await watchCommand(); break
    case 'queue': queueCommand(); break
    case 'work': workCommand(); break
    case 'submit': await submitCommand(); break
    case 'paid': paidCommand(); break
    case 'earnings': await earningsCommand(); break
    case 'demo': await demoCommand(); break
    case 'help': printHelp(); break
    default:
      printHelp()
      if (command) process.exitCode = 1
  }
} catch (error) {
  console.error(`✖ ${error.message}`)
  if (flags.verbose && error.stack) console.error(error.stack)
  process.exitCode = 1
}

async function doctor() {
  log('moltask-bot doctor')
  for (const warning of [...config.warnings, ...stateWarnings]) log(`! ${warning}`)
  log(`· api          ${config.apiBase}`)
  log(`· wallet       ${hasWallet(config) ? config.wallet : '(not set — discovery only)'}`)
  log(`· filters      categories=[${config.categories.join(',') || 'all'}] min=${config.minBounty} max=${config.maxBounty ?? '∞'}`)
  log(`· poll         every ${config.pollSeconds}s`)
  log(`· state        ${config.stateFile}`)

  const onboard = await api.onboard()
  log(`· platform     ${onboard.platform} v${onboard.version} — auth required: ${onboard.auth?.required}`)

  const open = await api.listTasks({ status: 'open', limit: 100 })
  const tasks = open?.tasks ?? []
  const suitable = filterTasks(tasks, config)
  log(`· open asks    ${tasks.length} fetched, ${suitable.length} suitable for this agent`)
  for (const entry of suitable.slice(0, 5)) {
    log(`    ${entry.verdict.bounty.toString().padStart(6)} MOLT  ${(entry.task.title ?? '').slice(0, 60)}  [${summarize(entry.verdict)}]`)
  }
  if (hasWallet(config)) {
    const profile = await api.getProfile(config.wallet)
    log(`· profile      ok, skills=[${(profile?.profile?.skills ?? []).join(', ') || 'empty'}]`)
  }
  const t = totals(state)
  log(`· state        queued=${t.queued} submitted=${t.submitted} earned=${t.earned} MOLT`)
  log('✔ doctor finished')
}

async function watchCommand() {
  const once = flags.once === true || positionals.includes('--once')
  const interval = Number(flags.interval ?? config.pollSeconds)
  if (Number.isFinite(interval) && interval > 0) config.pollSeconds = Math.max(5, interval)
  const maxCycles = once ? 1 : Number(flags['max-cycles'] ?? Infinity)
  log(`moltask-bot watch — every ${config.pollSeconds}s, ${once ? 'single cycle' : `${maxCycles === Infinity ? 'until interrupted' : `${maxCycles} cycles`}`}`)
  if (!hasWallet(config)) log('! no wallet configured: tasks can be queued, submissions will refuse')

  const controller = new AbortController()
  process.on('SIGINT', () => {
    log('· stopping after this cycle')
    controller.abort()
  })
  const result = await watch({
    api, config, state, maxCycles, signal: controller.signal, log,
    onCycle: cycle => { if (flags.verbose) log(`  ${JSON.stringify(cycle)}`) },
  })
  log(`✔ watch stopped: ${result.cycles} cycles, ${result.failures} failures, queue ${state.queue.length}`)
}

function queueCommand() {
  if (flags.json) {
    console.log(JSON.stringify(state.queue, null, 2))
    return
  }
  if (state.queue.length === 0) {
    log('queue is empty — run `moltask-bot watch --once` first')
    return
  }
  log(`${'#'.padStart(2)}  ${'MOLT'.padStart(6)}  ${'CATEGORY'.padEnd(10)}  TITLE`)
  state.queue.forEach((item, index) => {
    log(`${String(index + 1).padStart(2)}  ${String(item.bounty).padStart(6)}  ${(item.category || '—').padEnd(10)}  ${item.title}`)
  })
  const t = totals(state)
  log(`— queued ${t.queued}, submitted ${t.submitted}, earned ${t.earned} MOLT`)
}

function workCommand() {
  const key = positionals[0]
  const entry = key ? state.queue.find(item => item.key === key) : state.queue[0]
  if (!entry) throw new Error(key ? `no queued task with key ${key}` : 'queue is empty')
  const path = `${config.workOrderDir}/${key.replace(/^0x/, '').slice(0, 16)}.md`
  log(existsSync(path) ? readFileSync(path, 'utf8') : `work order file missing at ${path}; re-run watch to regenerate`)
}

async function submitCommand() {
  const key = positionals[0]
  if (!key) throw new Error('usage: moltask-bot submit <task-key> --message-file <path> [--link <url>] [--yes]')
  const entry = state.queue.find(item => item.key === key) ?? { key, id: null, title: '(not in queue)' }
  const taskId = flags['task-id'] ?? entry.id ?? (key.startsWith('0x') ? key : null)
  if (!taskId) throw new Error('no task id: pass --task-id or queue the task first')
  if (!hasWallet(config)) throw new Error('no wallet configured: set MOLTASK_WALLET or wallet in the config file')

  const messageFile = flags['message-file']
  if (!messageFile) throw new Error('--message-file is required: the submission must describe the delivered work')
  const message = readFileSync(messageFile, 'utf8')
  const payload = { workerAddress: config.wallet, message, linkUrl: flags.link, linkType: flags['link-type'] ?? 'other' }

  log(`submit ${entry.title}`)
  log(`  task    ${taskId} (key ${key})`)
  log(`  wallet  ${config.wallet}`)
  log(`  message ${message.length} chars from ${messageFile}`)
  if (payload.linkUrl) log(`  link    ${payload.linkUrl}`)
  if (!(flags.yes === true || flags.yes === 'true')) {
    log('— dry run: pass --yes to actually submit (this is public and attributed to the wallet)')
    return
  }
  const response = await api.submitWork(taskId, payload)
  markSubmitted(state, { key, taskId, linkUrl: payload.linkUrl, message })
  saveState(config.stateFile, state)
  log(`✔ submitted: ${JSON.stringify(response)}`)
}

/**
 * Record a payout the poster confirmed. The chain is the source of truth; this
 * keeps the local ledger in step so `earnings` is not a guess. No network.
 */
function paidCommand() {
  const key = positionals[0]
  if (!key) throw new Error('usage: moltask-bot paid <task-key> --amount <MOLT> [--note "text"]')
  const amount = Number(flags.amount)
  if (!Number.isFinite(amount) || amount <= 0) throw new Error('--amount must be a positive MOLT number')
  const submission = state.submissions.find(item => item.key === key)
  if (!submission) throw new Error(`no submission recorded for ${key} — submit the work first`)
  if (submission.paid === true) throw new Error(`submission ${key} is already marked paid`)
  const earning = recordEarning(state, { amount, key, note: flags.note ?? submission.taskId })
  submission.paid = true
  submission.paidAt = earning.at
  saveState(config.stateFile, state)
  const t = totals(state)
  log(`✔ recorded ${earning.amount} MOLT for ${key}`)
  log(`  ledger: submitted ${t.submitted}, earned ${t.earned} MOLT (you keep 97.5%, so ~${Math.round(earning.amount * 0.975 * 1000) / 1000} lands after fees)`)
}

async function earningsCommand() {  const t = totals(state)
  log(`local totals: queued ${t.queued}, submitted ${t.submitted}, earned ${t.earned} MOLT`)
  if (state.earnings.length > 0) {
    for (const earning of state.earnings) log(`  ${earning.at}  ${earning.amount} MOLT  ${earning.note}`)
  }
  if (hasWallet(config)) {
    const profile = await api.getProfile(config.wallet)
    log(`on-chain profile: ${profile.address} · reviews ${profile.reviews?.totalReviews ?? 0}`)
  }
}

async function demoCommand() {
  log('moltask-bot demo — read-only, nothing is submitted')
  const onboard = await api.onboard()
  log(`1. platform: ${onboard.platform} v${onboard.version} (auth required: ${onboard.auth?.required})`)

  const open = await api.listTasks({ status: 'open', limit: 100 })
  const tasks = open?.tasks ?? []
  log(`2. open asks fetched: ${tasks.length}`)

  const suitable = filterTasks(tasks, config)
  log(`3. suitable for this agent: ${suitable.length}`)
  suitable.slice(0, 5).forEach((entry, index) => {
    log(`   ${index + 1}. ${entry.verdict.bounty} MOLT · ${entry.task.category} · ${entry.task.title}`)
  })

  const before = state.queue.length
  const result = await runOnce({ api, config, state, log: line => log(`   ${line}`), persist: false })
  log(`4. cycle: fetched ${result.fetched}, suitable ${result.suitable}, new ${result.added}, queue ${before}→${state.queue.length}`)

  if (state.queue[0]) {
    log('5. first work order:')
    for (const line of workOrderMarkdown({ ...state.queue[0], description: '(see data/work-orders)' }, { bounty: state.queue[0].bounty, score: state.queue[0].score, key: state.queue[0].key }, config).split('\n').slice(0, 12)) {
      log(`   ${line}`)
    }
  }
  log('✔ demo finished — state was NOT written (persist: false)')
}

function printHelp() {
  log(`moltask-bot — monitor MolTask asks and queue work for an AI agent

Usage: moltask-bot <command> [options]

Commands:
  doctor                 Check config, wallet, API and queue
  watch --once           One poll cycle (queues new suitable asks)
  watch                  Poll continuously (default: every ${config.pollSeconds}s)
  queue [--json]         Show the work queue
  work [key]             Print a work order (best queued task by default)
  submit <key> --message-file <path> [--link <url>] [--yes]
                         Submit finished work; dry-run without --yes
  paid <key> --amount <MOLT> [--note "text"]
                         Record a confirmed payout in the local ledger
  earnings               Local totals plus the on-chain profile
  demo                   Read-only end-to-end demonstration

Environment:
  MOLTASK_WALLET         Base address that receives the MOLT payout
  MOLTASK_CATEGORIES     Comma list, e.g. coding,research,automation
  MOLTASK_MIN_BOUNTY     Ignore asks below this MOLT amount
  MOLTASK_MAX_BOUNTY     Ignore asks above this MOLT amount
  MOLTASK_KEYWORDS       Require one of these words in title/description
  MOLTASK_EXCLUDE        Skip asks containing any of these words
  MOLTASK_POLL_SECONDS   Poll interval (floor 5s, default 120)
  MOLTASK_STATE_FILE     State path (default ./data/state.json)
  MOLTASK_API_BASE       API base (default https://www.moltask.com/api)
  MOLTASK_CONFIG         Config file path (default ./moltask-bot.config.json)

MolTask has no API key and no claim endpoint: the wallet address is the identity,
and "queued" here means the bot reserved the task locally and wrote a work order.`)
}

function parseArgv(argv) {
  const flags = {}
  const positionals = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--once') flags.once = true
    else if (arg.startsWith('--')) {
      const name = arg.slice(2)
      const value = argv[i + 1]?.[0] === '-' ? undefined : argv[++i]
      flags[name] = value ?? true
    } else positionals.push(arg)
  }
  return { command: positionals.shift() ?? 'help', flags, positionals }
}
