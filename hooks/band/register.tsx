import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { boardHtml, tasksFrom } from './board'
import { EMPTY_OPT, advance, applyReply, buildPrompt, choices, closeRound, fieldRows, parseReply, roundDone, skillBody } from './optimizer'
import type { Band, Optimizer } from './types'
import type { Col } from './metrics'
import {
  GREP_DEFS,
  NO_TOKENS,
  addTokens,
  addedLines,
  callsIn,
  defsIn,
  duplicateOf,
  elapsed,
  fmtTokens,
  hits,
  isCode,
  isSource,
  isTestCommand,
  mainModel,
  markdown,
  metricsSvg,
  MODEL_PATTERN,
  parseDefs,
  percent,
  resume,
  snapshot,
  testCounts,
  sessionTitle,
  taskKey,
  testsLabel,
  TITLE_RECORD,
  totalTokens,
  upsertCsv,
  webhookRequest,
} from './metrics'

const LEVELS = ['off', 'lite', 'full', 'ultra']
const EMPTY: Band = {
  level: 'off',
  model: '',
  cost: 0,
  spent: 0,
  turns: 0,
  turnCosts: [],
  tokens: NO_TOKENS,
  busyMs: 0,
  name: '',
  project: '',
  session: '',
  transcript: '',
  reused: [],
  created: [],
  dupes: [],
  removed: [],
  openCallers: [],
  tests: { state: 'none' },
  details: false,
}
// The counters of one task: what a new session or /clear starts over.
const TASK = {
  spent: 0,
  turns: 0,
  turnCosts: [],
  tokens: NO_TOKENS,
  busyMs: 0,
  name: '',
  model: '',
  reused: [],
  created: [],
  dupes: [],
  removed: [],
  openCallers: [],
  tests: { state: 'none' as const },
}
const band = atom({ plugin: 'ponytail-forge', key: 'band' } as const, EMPTY)
const optimizer = atom({ plugin: 'ponytail-forge', key: 'optimizer' } as const, EMPTY_OPT)
// State kept from an older version of the band lacks newer fields.
const load = async ($: EngineInterface): Promise<Band> => ({ ...EMPTY, ...(await read($, band)) })
const loadOpt = async ($: EngineInterface): Promise<Optimizer> => ({ ...EMPTY_OPT, ...(await read($, optimizer)) })

const union = (a: string[], b: string[]) => [...new Set([...a, ...b])]
const base = (path: string) => path.replace(/\/+$/, '').split('/').pop() ?? path

// Windows sets USERPROFILE, not HOME.
const home = async ($: EngineInterface) => (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE'))
const claudeDir = async ($: EngineInterface) => (await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${await home($)}/.claude`

// `/ponytail band` (the mode tracker) leaves "off" here to hide the band. Absent flag = shown.
async function bandHidden($: EngineInterface): Promise<boolean> {
  try {
    return (await $.fs.read(`${await claudeDir($)}/.ponytail-band`)).trim() === 'off'
  } catch {
    return false
  }
}

// The level ponytail's own hooks write. Absent flag = off.
// shortcut: the shared flag the statusline reads, so two sessions in different repos show the last switch; read the per-project flag if that matters.
async function readLevel($: EngineInterface): Promise<string> {
  const dir = await claudeDir($)
  try {
    const level = (await $.fs.read(`${dir}/.ponytail-active`)).trim()
    return LEVELS.includes(level) ? level : 'off'
  } catch {
    return 'off'
  }
}

// The same commands a person types, so ponytail's own skills and hooks stay the only logic.
const run = ($: EngineInterface, command: string, args = '') => $.command.run({ command, args })

type Options = { readonly [field: string]: unknown }

const PANE = 'optimizer'
const OPEN = { id: PANE, title: 'Prompt optimizer', focus: true } as const

// One model call for the optimizer: a fork of the session, so the model sees what the conversation already settled.
async function askModel($: EngineInterface, skill: string, prompt: string, model: string): Promise<string> {
  const forked = await $.model.fork({ prompt: `${skill}\n\n${prompt}`, effort: 'low' })
  if (forked.isAnswered) return forked.text
  if (forked.reason !== 'nothing-to-fork') throw new Error(`model: ${forked.reason}`)
  // Before the first turn there is no conversation to fork.
  // The default 1024-token cap would cut a long forged prompt off mid-JSON.
  const r = await $.model.complete({ model, system: skill, prompt, maxTokens: 8000, timeoutMs: 120_000 })
  if (!r.isAnswered) throw new Error(`model: ${r.reason}`)
  return r.text
}

// One optimizer step: ask the model about the draft and the rounds answered so far, then keep its reply.
// `prep` sets the state the step starts from, or refuses it (undefined) so a double press starts one call, not two.
// The run number lets a newer step drop an older, slower reply; a failure puts the state from before the step back
// with the error, so the typed answers and a forged prompt stay reachable and the same button retries.
// shortcut: the fork's cost is part of the session total, so the band's "last $" can include it; it is not split out.
async function step($: EngineInterface, options: Options, push = false, prep: (o: Optimizer) => Optimizer | undefined = o => o) {
  let before = EMPTY_OPT
  const claim = { ok: false }
  const started = await update($, optimizer, x => {
    before = { ...EMPTY_OPT, ...x }
    const next = prep(before)
    if (next === undefined) return x
    claim.ok = true
    return { ...next, phase: 'working' as const, run: next.run + 1, error: '' }
  })
  if (!claim.ok) return
  const run = started.run
  try {
    const skill = skillBody(await $.fs.read(`${$.plugin.root}/skills/prompt-optimizer/SKILL.md`))
    const model = typeof options.optimizerModel === 'string' && options.optimizerModel !== '' ? options.optimizerModel : 'sonnet'
    const reply = parseReply(await askModel($, skill, buildPrompt(started, push), model))
    if (reply.status === 'error') throw new Error(reply.error)
    await update($, optimizer, x => (({ ...EMPTY_OPT, ...x }).run === run ? applyReply({ ...EMPTY_OPT, ...x }, reply) : x))
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    await update($, optimizer, x => (({ ...EMPTY_OPT, ...x }).run === run ? { ...before, run, error } : x))
  }
}

// The session's sidebar name. grep, because $.fs.read refuses files over 4 MiB and transcripts grow past that.
// shortcut: without grep (Windows) only a transcript under 4 MiB is read; findstr would lift that.
async function readTitle($: EngineInterface, transcript: string): Promise<string | undefined> {
  if (transcript === '') return undefined
  const grep = await $.process.run(['grep', '-F', TITLE_RECORD, transcript]).catch(() => undefined)
  const text = grep !== undefined && grep.exitCode <= 1 ? grep.stdout : await $.fs.read(transcript).catch(() => '')
  return sessionTitle(text)
}

// The model that wrote most of the session's replies, so the board can tell models apart.
async function readModel($: EngineInterface, transcript: string): Promise<string> {
  if (transcript === '') return ''
  const grep = await $.process.run(['grep', '-o', MODEL_PATTERN, transcript]).catch(() => undefined)
  return grep?.exitCode === 0 ? mainModel(grep.stdout) : ''
}

// Where the task ledgers and the board live.
// shortcut: ~/.config only (XDG respected); Windows would want %APPDATA%.
async function ledgerDir($: EngineInterface) {
  return `${(await $.env.get('XDG_CONFIG_HOME')) ?? `${await home($)}/.config`}/ponytail/band`
}

const ledgerFile = (dir: string, project: string) => `${dir}/${project.replace(/[^\w.-]/g, '_')}.csv`

// After every turn: the task's row in a CSV per project, and the same row to a webhook if one is set.
async function record($: EngineInterface, b: Band, options: Options) {
  const startedAt = (await $.session.usage()).startedAt
  const row = snapshot(b, startedAt)
  if (options.ledger !== false && b.project !== '') {
    const dir = await ledgerDir($)
    const file = ledgerFile(dir, b.project)
    const existing = await $.fs.read(file).catch(() => '')
    // $.fs.write creates the directory: no mkdir, which Windows does not have.
    await $.fs.write(file, upsertCsv(existing, row))
    // The board is a plain file a refresh rereads, so it is rebuilt with every row.
    await writeBoard($, dir)
  }
  const url = typeof options.webhookUrl === 'string' ? options.webhookUrl.trim() : ''
  if (url !== '') {
    const token = typeof options.webhookToken === 'string' ? options.webhookToken.trim() : ''
    const request = webhookRequest(url, token, options.sendNames !== false, row)
    if ('refused' in request) {
      $.ui.status(`ponytail band: ${request.refused}`)
      return
    }
    // Not awaited: a slow endpoint must never hold up the turn.
    void $.http
      .fetch(request.url, request.init)
      .then(r => $.ui.status(r.ok ? undefined : `ponytail band: webhook answered ${r.status}`))
      .catch(() => $.ui.status('ponytail band: webhook unreachable'))
  }
}

// Builds board.html from every project's ledger.
async function writeBoard($: EngineInterface, dir: string) {
  const entries = await $.fs.list(dir).catch(() => [])
  const texts = await Promise.all(entries.filter(f => f.kind === 'file' && f.name.endsWith('.csv')).map(f => $.fs.read(`${dir}/${f.name}`).catch(() => '')))
  const file = `${dir}/board.html`
  await $.fs.write(file, boardHtml(texts.flatMap(tasksFrom), await $.clock.now()))
  return file
}

// Builds the board fresh and opens it in the browser.
async function openBoard($: EngineInterface) {
  const file = await writeBoard($, await ledgerDir($))
  const windows = (await $.env.get('OS')) === 'Windows_NT'
  const mac = !windows && (await $.process.run(['uname'])).stdout.trim() === 'Darwin'
  await $.process.run(windows ? ['cmd', '/c', 'start', '', file] : [mac ? 'open' : 'xdg-open', file])
}

// Sets the band up for a session (level, project, task row, cost baseline); returns the definitions that exist now.
async function start($: EngineInterface): Promise<Map<string, string>> {
  const grep = await $.process.run(['git', 'grep', '--untracked', '-nE', GREP_DEFS]).catch(() => undefined)
  const level = await readLevel($)
  const details = (await $.store.get('details')) === true
  const optimizerOn = (await $.store.get('optimizer')) === true
  const repo = await $.session.repo().catch(() => null)
  const project = base(repo?.root ?? (await $.session.cwd()))
  const session = await $.session.id()
  // The cost so far is the baseline for the last turn's own cost.
  const usage = await $.session.usage().catch(() => undefined)
  const csv = usage ? await $.fs.read(ledgerFile(await ledgerDir($), project)).catch(() => '') : ''
  const key = usage ? taskKey(session, usage.startedAt) : ''
  await update($, band, b => resume({ ...EMPTY, ...b, level, details, project, session, cost: usage?.cost?.usd ?? b.cost }, csv, key))
  await update($, optimizer, o => ({ ...EMPTY_OPT, ...o, on: optimizerOn }))
  // No focus: the pane comes back on its own, it must not take the keyboard from the prompt box.
  if (optimizerOn) void $.ui.open({ id: PANE, title: OPEN.title })
  return grep?.exitCode === 0 ? parseDefs(grep.stdout) : new Map()
}

export const register: Register = (on, options) => {
  // Definitions that existed when the session started: what new code can reuse.
  let known = new Map<string, string>()

  on('session.start', async ($, e, next) => {
    known = await start($)
    return next(e)
  }).catch(($, e, next) => next(e))

  // /clear and /resume go on under another session id with an empty band and no session.start, so the band showed
  // "off" until the first turn ended. Set it up again once a command has moved the session.
  // shortcut: after /clear, ponytail-activate.js may reset the flag to the default level after this, so a level switched
  // before /clear can show until the first turn ends; a session skips a plugin's classic.SessionStart hook, the one later point.
  on('command.run', async ($, e, next) => {
    const session = await $.session.id()
    const result = await next(e)
    if ((await $.session.id()) !== session) known = await start($).catch(() => known)
    return result
  }).catch(($, e, next) => next(e))

  // /clear starts a new task: the counters start over, the cost baseline stays.
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') await update($, band, b => ({ ...EMPTY, ...b, ...TASK }))
    return next(e)
  }).catch(($, e, next) => next(e))

  // Only the classic hook input carries the transcript path, which holds the sidebar name.
  on('classic.UserPromptSubmit', async ($, e, next) => {
    await update($, band, b => (b.transcript === e.transcript_path ? b : { ...EMPTY, ...b, transcript: e.transcript_path }))
    return next(e)
  }).catch(($, e, next) => next(e))

  // The first prompt names the task until the session has a sidebar name.
  on('prompt.submit', async ($, e, next) => {
    const text = e.text.trim()
    if (e.origin.kind !== 'plugin' && text !== '' && !text.startsWith('/')) {
      const name = (text.split('\n')[0] ?? '').slice(0, 60)
      await update($, band, b => (b.name === '' ? { ...EMPTY, ...b, name } : b))
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    if (e.tool === 'Bash') {
      const ran = await next(e)
      if (ran.deny === undefined && isTestCommand(e.command)) {
        const tests = { state: ran.isError ? ('fail' as const) : ('pass' as const), ...testCounts(ran.text ?? '') }
        await update($, band, b => ({ ...b, tests }))
      }
      return ran
    }

    if (e.tool !== 'Edit' && e.tool !== 'Write') return next(e)

    const file = e.file_path
    const before = e.tool === 'Write' ? await $.fs.read(file).catch(() => '') : e.old_string
    const after = e.tool === 'Write' ? e.content : e.new_string
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError) return ran

    const oldDefs = defsIn(file, before)
    const newDefs = defsIn(file, after)
    const created = isSource(file) ? newDefs.filter(n => !oldDefs.includes(n)) : []
    const removed = oldDefs.filter(n => !newDefs.includes(n))
    const reused = isSource(file) ? callsIn(addedLines(before, after), known, newDefs) : []
    const dupes = created.flatMap(name => {
      const like = duplicateOf(name, file, known)
      return like ? [{ name, like }] : []
    })

    await update($, band, b => ({
      ...b,
      reused: union(b.reused, reused),
      created: union(b.created, created),
      dupes: [...b.dupes, ...dupes.filter(d => !b.dupes.some(x => x.name === d.name))],
      removed: union(b.removed, removed),
      tests: isCode(file) && b.tests.state !== 'none' ? { ...b.tests, state: 'stale' as const } : b.tests,
    }))

    return ran
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const used = e.usage
    if (e.agentId !== undefined) {
      // A subagent's tokens count; its cost is already in the session cost the main turn reads.
      if (used) await update($, band, b => ({ ...EMPTY, ...b, tokens: addTokens(b.tokens ?? NO_TOKENS, used) }))
      return next(e)
    }

    const usage = await $.session.usage()
    const turns = await $.session.turns()
    const level = await readLevel($)
    const { removed, transcript } = await load($)
    const title = await readTitle($, transcript)
    const model = await readModel($, transcript)

    // A removed or renamed definition that is not defined again but still called somewhere.
    // shortcut: name match with git grep, so a same-named call in another module counts too.
    const stillRemoved: string[] = []
    const open: string[] = []
    for (const name of removed) {
      const grep = await $.process.run(['git', 'grep', '--untracked', '-nw', '-e', name]).catch(() => undefined)
      const rows = hits(grep?.stdout ?? '')
      if (rows.some(r => defsIn(r.file, r.text.trimStart()).includes(name))) continue
      const call = new RegExp(`(?<![\\w$])${name.replace(/\$/g, '\\$')}\\s*\\(`)
      const refs = rows.filter(r => call.test(r.text)).map(r => `${r.file}:${r.line}`)
      if (refs.length > 0) {
        stillRemoved.push(name)
        open.push(...refs)
      }
    }

    const b = await update($, band, x => {
      const b = { ...EMPTY, ...x }
      const cost = usage.cost?.usd ?? b.cost
      // A cost below the baseline means the engine started its ledger over.
      const turn = cost >= b.cost ? cost - b.cost : cost
      return {
        ...b,
        level,
        cost,
        // Cost and turns are the session's own totals, so a reload or a second band never starts them over.
        spent: usage.cost?.usd ?? b.spent + turn,
        turns,
        turnCosts: [...b.turnCosts, turn].slice(-20),
        tokens: used ? addTokens(b.tokens, used) : b.tokens,
        busyMs: b.busyMs + e.durationMs,
        name: title ?? b.name,
        model: model || b.model,
        removed: stillRemoved,
        openCallers: open,
      }
    })
    await record($, b, options).catch(() => $.ui.status('ponytail band: could not write the task ledger'))

    return next(e)
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || (await bandHidden($))) return next(e)
    // Other mods share this slot: draw theirs below ours instead of replacing it.
    // next(e) rejects only when nothing answers beneath (the test harness): the band still draws.
    const below = await next(e).catch(() => undefined)

    const b = await load($)
    const now = await $.clock.now()
    const startedAt = (await $.session.usage().catch(() => undefined))?.startedAt ?? now
    const reuse = percent(b.reused.length, b.created.length)
    const avg = b.turns > 0 ? b.spent / b.turns : 0
    const last = b.turnCosts[b.turnCosts.length - 1]

    const setLevel = async (level: string) => {
      await update($, band, x => ({ ...x, level }))
      await run($, 'ponytail-forge:ponytail', level)
    }
    const toggle = async () => {
      await update($, band, x => ({ ...x, details: !x.details }))
      await $.store.set('details', !b.details)
    }
    const review = () => run($, 'ponytail-forge:ponytail-review')
    const audit = () => run($, 'ponytail-forge:ponytail-audit')
    const opt = await loadOpt($)
    const toggleOpt = async () => {
      // Flip the live value, not the one captured when this row was drawn.
      const { on: enable } = await update($, optimizer, x => {
        const y = { ...EMPTY_OPT, ...x }
        return { ...y, on: !y.on }
      })
      await $.store.set('optimizer', enable)
      if (enable) await $.ui.open(OPEN)
      else await $.ui.close({ id: PANE })
    }
    const board = () => openBoard($).catch(() => $.ui.toast('ponytail band: could not open the board'))
    const copy = async () => {
      const done = await $.ui.copy({ text: markdown(snapshot(await load($), startedAt)), surface: e.surface })
      $.ui.toast(done.isCopied ? 'Task copied as Markdown' : `Copy failed: ${done.reason}`)
    }

    const { Box, Text, Button } = $.ui.resolve(e)
    const stack = (mine: NonNullable<typeof below>) => (below ? <Box flexDirection="column">{mine}{below}</Box> : mine)

    const testsText =
      b.tests.state === 'pass'
        ? `✓ ${b.tests.passed ?? ''} tests`
        : b.tests.state === 'fail'
          ? `✗ ${b.tests.failed ?? ''} failed`
          : b.tests.state === 'stale'
            ? 'no test since change'
            : ''
    const testsColor = b.tests.state === 'pass' ? 'success' : b.tests.state === 'fail' ? 'error' : undefined
    const dupe = b.dupes[0]
    const hasDupes = dupe !== undefined
    const hasOpen = b.openCallers.length > 0

    if (!b.details) {
      return stack(
        <Box flexDirection="row" alignItems="center" gap={2} width={e.props.bodyColumns}>
          {/* A click opens the four levels: one click, one turn, no stops on levels nobody wanted. */}
          <Button key="level" plain onPress={toggle}>
            <Text color={b.level === 'off' ? 'inactive' : 'suggestion'}>●</Text> {b.level}
          </Button>
          <Text>${b.spent.toFixed(2)}</Text>
          {last !== undefined && <Text dimColor>last ${last.toFixed(2)}</Text>}
          <Text dimColor>{elapsed(b.busyMs)}</Text>
          {reuse !== undefined && <Text>{reuse}% reuse</Text>}
          {hasDupes && <Text color="warning">{b.dupes.length} duplicate?</Text>}
          {hasOpen && <Text color="warning">⚠ {b.openCallers.length} callers open</Text>}
          {testsText !== '' && (
            <Text color={testsColor} dimColor={b.tests.state === 'stale'}>
              {testsText}
            </Text>
          )}
          <Box flexGrow={1} />
          <Button key="optimize" plain onPress={toggleOpt}>
            <Text color={opt.on ? 'suggestion' : 'inactive'}>●</Text> Optimize
          </Button>
          <Button key="review" plain label="Review" onPress={review} />
          <Button key="audit" plain label="Audit" onPress={audit} />
          <Button key="board" plain label="Board" onPress={board} />
          <Button key="details" plain label="Details" onPress={toggle} />
        </Box>
      )
    }

    // Only columns that say something; callers and tests appear once there is something to report.
    const cols: Col[] = [
      { key: 'cost', label: 'cost', value: `$${b.spent.toFixed(2)}`, sub: last === undefined ? '' : `last $${last.toFixed(2)} · ⌀ $${avg.toFixed(2)}` },
      { key: 'tokens', label: 'tokens', value: fmtTokens(totalTokens(b.tokens)), sub: `${fmtTokens(b.tokens.output)} out · ${b.turns} ${b.turns === 1 ? 'turn' : 'turns'}` },
      { key: 'time', label: 'agent time', value: elapsed(b.busyMs), sub: b.turns > 0 ? `⌀ ${elapsed(b.busyMs / b.turns)} / turn` : '' },
    ]
    if (b.reused.length + b.created.length > 0) {
      cols.push({
        key: 'reuse',
        label: 'reuse',
        value: reuse === undefined ? `${b.created.length} new` : `${reuse}%`,
        sub: dupe ? `${dupe.name} ≈ ${dupe.like}` : reuse === undefined ? `${b.reused.length} reused` : `${b.reused.length} used · ${b.created.length} new`,
        tone: hasDupes ? 'warning' : undefined,
      })
    }
    if (hasOpen) {
      cols.push({ key: 'callers', label: 'callers', value: `${b.openCallers.length} open`, sub: b.openCallers.slice(0, 2).join(', '), tone: 'warning' })
    }
    if (b.tests.state !== 'none') {
      cols.push({
        key: 'tests',
        label: 'tests',
        value: testsLabel(b.tests),
        sub: b.tests.state === 'pass' ? 'after last change' : b.tests.state === 'fail' ? 'last run' : 'code changed since',
        tone: b.tests.state === 'pass' ? 'success' : b.tests.state === 'fail' ? 'error' : undefined,
      })
    }

    let metrics = (
      <Box flexDirection="column" gap={1}>
        <Text dimColor wrap="truncate-end">
          {'─'.repeat(e.props.bodyColumns)}
        </Text>
        <Box flexDirection="row" gap={2}>
          {cols.map(c => (
            <Box key={c.key} flexDirection="column" width={Math.max(10, Math.floor(e.props.bodyColumns / cols.length) - 2)}>
              <Text dimColor>{c.label}</Text>
              <Text bold color={c.tone}>
                {c.value}
              </Text>
              <Text dimColor wrap="truncate-end">
                {c.sub}
              </Text>
            </Box>
          ))}
        </Box>
      </Box>
    )
    // Text glyphs make broken lines in the desktop's proportional font; an SVG draws real ones.
    if (e.surface === 'desktop') {
      const { Svg } = $.ui.resolve(e)
      metrics = <Svg source={metricsSvg(cols, b.turnCosts)} alt={cols.map(c => `${c.label} ${c.value}`).join(', ')} />
    }

    return stack(
      <Box flexDirection="column" gap={1} width={e.props.bodyColumns}>
        <Box flexDirection="row" alignItems="center" gap={1}>
          {LEVELS.map(level => (
            <Button
              key={`level-${level}`}
              label={level}
              {...(level === b.level ? { variant: 'primary' as const } : { plain: true as const, dimColor: true })}
              onPress={() => setLevel(level)}
            />
          ))}
          <Box flexGrow={1} />
          <Button key="copy" plain label="Copy" onPress={copy} />
          <Button key="optimize" label="Optimize" {...(opt.on ? { variant: 'primary' as const } : { plain: true as const })} onPress={toggleOpt} />
          <Button key="review" plain label="Review" onPress={review} />
          <Button key="audit" plain label="Audit" onPress={audit} />
          <Button key="board" plain label="Board" onPress={board} />
          <Button key="details" plain label="Compact" onPress={toggle} />
        </Box>
        {metrics}
      </Box>
    )
  }).catch(($, e, next) => next(e))

  // The person closing the pane with its close mark switches the optimizer off, so the button never lies.
  on('ui.close', async ($, e, next) => {
    if (e.id === PANE) {
      await update($, optimizer, o => ({ ...EMPTY_OPT, ...o, on: false }))
      await $.store.set('optimizer', false)
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // The optimizer panel: one grill question at a time, then the forged prompt and a field to revise it.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const o = await loadOpt($)
    const { Box, Text, Button, Input } = $.ui.resolve(e)

    const live = (f: (x: Optimizer) => Partial<Optimizer>) => update($, optimizer, x => ({ ...EMPTY_OPT, ...x, ...f({ ...EMPTY_OPT, ...x }) }))
    const optimize = async () => {
      const { text } = await $.prompt.read()
      if (text.trim() === '') return $.ui.toast('Type a draft in the prompt box first')
      await step($, options, false, x => ({ ...EMPTY_OPT, on: x.on, run: x.run, original: text }))
    }
    // The round goes to the model by itself once the last question is answered; a second press finds nothing to send.
    const send = () => step($, options, false, x => (roundDone(x) ? closeRound(x) : undefined))
    // `typed` is what an Enter in the field carried; it is saved before the answer is read.
    const next = async (skip: boolean, typed?: string) => {
      const after = await update($, optimizer, x => {
        const y = { ...EMPTY_OPT, ...x }
        return advance(typed === undefined ? y : { ...y, custom: typed }, skip)
      })
      if (roundDone(after)) await send()
    }
    // Both the field's Enter and Grill harder take the instruction typed so far; an empty field alone does nothing.
    const revise = (push: boolean) => step($, options, push, x => (x.phase === 'done' && (push || x.instruction.trim() !== '') ? x : undefined))
    const use = async () => {
      const r = await $.prompt.fill({ text: o.optimized, mode: 'replace' })
      $.ui.toast(r.isFilled ? 'Optimized prompt is in the prompt box' : 'Could not fill the prompt box')
    }
    const copy = async () => {
      const r = await $.ui.copy({ text: o.optimized, surface: e.surface })
      $.ui.toast(r.isCopied ? 'Optimized prompt copied' : `Copy failed: ${r.reason}`)
    }

    const q = o.pending[o.cur]
    const typing = o.custom.trim() !== ''
    const pad = e.surface === 'desktop' ? 1 : 0
    const cols = e.props.bodyColumns
    const rowsFor = (text: string) => fieldRows(text, cols, e.props.scroll?.bodyRows ?? 20, e.surface === 'desktop')
    // Ideal Finans' palette where the pane can colour it: gold marks the choice and the result, slate is the muted tone.
    // shortcut: one muted colour for both themes, as the pane cannot read the app's light or dark; slate is weaker on dark.
    const GOLD = '#A98B4F'
    const SLATE = '#5A6A79'
    // A button with nothing to do in this phase stays on screen, dimmed, so the bar never changes shape.
    const btn = (key: string, label: string, onPress: () => unknown, enabled = true) =>
      enabled ? <Button key={key} variant="secondary" label={label} onPress={onPress} /> : <Button key={key} plain dimColor label={label} onPress={() => undefined} />
    const finished = o.phase === 'done'
    const last = o.rounds[o.rounds.length - 1]
    const MARK = ' (accepted recommendation)'

    return (
      <Box flexDirection="column" gap={1} width={cols}>
        {/* Its own framed block: the border sets it off the pane, and the column's gap keeps it from the content. */}
        <Box flexDirection="column" gap={1} borderStyle="single" borderColor={SLATE} paddingX={1} paddingY={pad}>
          <Box flexDirection="row" alignItems="center" gap={1}>
            {btn('go', o.phase === 'idle' ? 'Optimize draft' : 'Start over', optimize)}
            {btn('use', 'Use', use, finished)}
            {btn('copy', 'Copy', copy, finished)}
          </Box>
          <Box flexDirection="row" alignItems="flex-start" gap={1}>
            <Box flexGrow={1}>
              <Input
                key="instruction"
                placeholder="Instruktion til Grill harder…"
                rows={rowsFor(o.instruction)}
                value={finished ? o.instruction : ''}
                onInput={v => finished && live(() => ({ instruction: v }))}
                onSubmit={v => finished && live(() => ({ instruction: v })).then(() => revise(false))}
              />
            </Box>
            {btn('harder', 'Grill harder', () => revise(true), finished)}
          </Box>
        </Box>
        {o.error !== '' && <Text color="error">{o.error}</Text>}
        {o.phase === 'asking' && q === undefined && btn('retry', 'Send answers', send)}
        {o.phase === 'idle' && (
          <Box flexDirection="column" gap={1}>
            <Text bold>Ingen prompt endnu</Text>
            <Text>Skriv et udkast i promptboksen. Panelet stiller få, korte spørgsmål og skriver en skarpere version, som du kan sætte ind igen.</Text>
            <Text color={SLATE}>Spørgsmålene kommer ét ad gangen, med en anbefalet mulighed først.</Text>
            <Box borderStyle="dashed" borderColor={SLATE} height={5} alignItems="center" justifyContent="center">
              <Text color={SLATE}>Venter på udkast</Text>
            </Box>
          </Box>
        )}
        {o.phase === 'working' && (
          <Box flexDirection="column" gap={1}>
            <Text bold>Skriver en skarpere version</Text>
            <Text>{last === undefined ? 'Udkastet er sendt.' : 'Runden er sendt.'}</Text>
            <Box borderStyle="single" borderColor={SLATE}>
              <Box width="60%" height={1} backgroundColor={GOLD} />
            </Box>
            {last !== undefined && (
              <Box flexDirection="column" borderStyle="single" borderColor={SLATE} paddingX={1} paddingY={pad}>
                <Text bold>Svar i denne runde</Text>
                {last.questions.map((lq, j) => {
                  const a = last.answers[j] ?? ''
                  return (
                    <Box key={`r${j}`} flexDirection="row" gap={1}>
                      <Box width={14} flexShrink={0}>
                        <Text color={SLATE} wrap="truncate-end">{lq.title}</Text>
                      </Box>
                      <Text>{a.endsWith(MARK) ? `Skip: ${a.slice(0, -MARK.length)}` : a}</Text>
                    </Box>
                  )
                })}
              </Box>
            )}
          </Box>
        )}
        {o.phase === 'asking' && q !== undefined && (
          <Box flexDirection="column" gap={1} borderStyle="single" borderColor={SLATE} paddingX={1} paddingY={pad}>
            <Box flexDirection="row" gap={1}>
              <Text bold>{q.title}</Text>
              <Box flexGrow={1} />
              <Text color={SLATE}>{`${o.cur + 1}/${o.pending.length}`}</Text>
            </Box>
            {q.body !== '' && <Text>{q.body}</Text>}
            <Box flexDirection="column">
              {choices(q).map((opt, i) => {
                const picked = !typing && o.choice === i
                return (
                  <Box key={`o${i}`} borderStyle={picked ? 'bold' : 'single'} borderColor={picked ? GOLD : SLATE}>
                    <Button key={`opt-${i}`} plain onPress={() => live(() => ({ choice: i, custom: '' }))}>
                      <Text bold={picked}>{`(${picked ? '•' : ' '}) ${opt}`}</Text>
                      {i === 0 && <Text color={SLATE}>{'    Recommended'}</Text>}
                    </Button>
                  </Box>
                )
              })}
            </Box>
            <Input
              key="custom"
              placeholder="Type something else…"
              rows={rowsFor(o.custom)}
              value={o.custom}
              onInput={v => live(() => ({ custom: v }))}
              onSubmit={v => next(false, v)}
            />
            <Box flexDirection="row" alignItems="center">
              {btn('skip', 'Skip', () => next(true))}
              <Box flexGrow={1} />
              {btn('next', 'Next', () => next(false))}
            </Box>
            <Text color={SLATE}>Skip bruger den anbefalede mulighed. Efter sidste spørgsmål sendes runden automatisk.</Text>
          </Box>
        )}
        {finished && (
          <Box flexDirection="column" gap={1}>
            <Box flexDirection="column">
              <Text bold>Optimized prompt</Text>
              <Box borderStyle="bold" borderColor={GOLD} paddingX={1} paddingY={pad}>
                <Text>{o.optimized}</Text>
              </Box>
            </Box>
            {o.note !== '' && (
              <Box flexDirection="column">
                <Text bold>Note</Text>
                <Text>{o.note}</Text>
              </Box>
            )}
            {o.assumptions.length > 0 && (
              <Box flexDirection="column">
                <Text bold>Assumptions</Text>
                {o.assumptions.map((a, i) => (
                  <Box key={`s${i}`} flexDirection="row" gap={1}>
                    <Box width={2} flexShrink={0}>
                      <Text color={SLATE}>{`${i + 1}`}</Text>
                    </Box>
                    <Text>{a}</Text>
                  </Box>
                ))}
              </Box>
            )}
          </Box>
        )}
      </Box>
    )
  }).catch(($, e, next) => next(e))
}
