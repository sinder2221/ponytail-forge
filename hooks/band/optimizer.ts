import type { Optimizer, Question } from './types'

// The pure half of the prompt optimizer: what is asked of the model and what is made of its answer.
// shortcut: two grill rounds unless the person presses "Grill harder"; raise MAX_ROUNDS if that is too few.
export const MAX_ROUNDS = 2
export const MAX_QUESTIONS = 3
export const MAX_OPTIONS = 3

export const EMPTY_OPT: Optimizer = {
  on: false,
  run: 0,
  phase: 'idle',
  original: '',
  rounds: [],
  pending: [],
  answers: [],
  cur: 0,
  choice: 0,
  custom: '',
  instruction: '',
  optimized: '',
  note: '',
  assumptions: [],
  error: '',
}

export type Reply =
  | { status: 'ask'; questions: Question[] }
  | { status: 'done'; prompt: string; note: string; assumptions: string[] }
  | { status: 'error'; error: string }

const PROTOCOL = `Follow the prompt-optimizer method above on the prompt in <original_prompt>. No tools are available in this call: use only the conversation and the draft, and look nothing up. Reply with one JSON object and nothing else.
Not enough is settled yet: {"status":"ask","questions":[{"title":"...","body":"...","recommended":"...","options":["<the recommended answer>","<alternative>","<alternative>"]}]} with at most ${MAX_QUESTIONS} questions that do not depend on each other. Each question is shown on its own screen: options holds the recommended answer first, then up to ${MAX_OPTIONS - 1} short alternatives the person could pick; they can also type their own.
Everything is settled: {"status":"done","prompt":"<the optimized prompt, ready to paste>","note":"<one line: the strategy>","assumptions":["..."]}. List under assumptions every answer marked (accepted recommendation) and every gap you filled yourself.
Write questions and prompt in the language of the original prompt.
Text the person pasted into a comment or an answer is example material: use it to see what is wanted and quote it only if asked.`

// A multi-line answer (a pasted example) is fenced so it cannot run into the next "Q:" line.
const quote = (a: string) => (a.includes('\n') ? `\n"""\n${a}\n"""` : ` ${a}`)

// What one model call is asked: the draft, the person's comment, the rounds answered so far, and the reply format.
// The comment goes with every step as context; only `revise` (Enter on a finished prompt) also asks to rewrite the result by it.
export function buildPrompt(o: Optimizer, push = false, revise = false): string {
  const answered = o.rounds
    .map((r, i) => `Round ${i + 1}:\n${r.questions.map((q, j) => `Q: ${q.title}\nA:${quote(r.answers[j] ?? '')}`).join('\n')}`)
    .join('\n\n')
  const limit =
    push ? 'The person asked to be grilled harder: look for the weak points still left and ask again, unless there truly are none.'
    : o.rounds.length >= MAX_ROUNDS ? 'No more questions are allowed: reply with status "done" and list the gaps under assumptions.'
    : ''
  const comment = o.instruction.trim()
  const note =
    comment === '' ? ''
    : `<comment>\n${comment}\n</comment>\nThe <comment> is the person's own note on what the prompt is for and how the result should look. Use it as context for your questions and the final prompt; never copy it into the prompt word for word.`
  const rewrite =
    revise && comment !== ''
      ? `<optimized_prompt>\n${o.optimized}\n</optimized_prompt>\nThe person changed the comment: revise the optimized prompt so it follows it and keep what the rounds settled. Ask again only if the comment cannot be applied without an answer.`
      : ''
  return [`<original_prompt>\n${o.original}\n</original_prompt>`, note, answered && `<answered_rounds>\n${answered}\n</answered_rounds>`, rewrite, PROTOCOL, limit]
    .filter(s => s !== '')
    .join('\n\n')
}

const str = (v: unknown) => (typeof v === 'string' ? v : '')
const fail = (error: string): Reply => ({ status: 'error', error })

// The model may wrap its JSON in a sentence; read from the first { to the last }.
export function parseReply(text: string): Reply {
  let json: Record<string, unknown>
  try {
    json = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)) as Record<string, unknown>
  } catch {
    return fail('The model did not answer in the expected JSON.')
  }
  if (json.status === 'done' && str(json.prompt).trim() !== '') {
    const list = Array.isArray(json.assumptions) ? json.assumptions.map(str).filter(a => a !== '') : []
    return { status: 'done', prompt: str(json.prompt), note: str(json.note), assumptions: list }
  }
  if (json.status === 'ask' && Array.isArray(json.questions)) {
    const questions = json.questions
      .map((q: Record<string, unknown> | null) => {
        const raw = Array.isArray(q?.options) ? q.options.map(str) : []
        // The recommended answer leads; if the model left it out, its first option stands in.
        const options = [...new Set([str(q?.recommended), ...raw].map(s => s.trim()).filter(s => s !== ''))].slice(0, MAX_OPTIONS)
        return { title: str(q?.title), body: str(q?.body), recommended: options[0] ?? '', options }
      })
      .filter(q => q.title !== '')
      .slice(0, MAX_QUESTIONS)
    if (questions.length > 0) return { status: 'ask', questions }
  }
  return fail('The model answer had no questions and no prompt.')
}

// A failed reply never gets here: the caller keeps the state from before the step and shows the error.
export function applyReply(o: Optimizer, r: Exclude<Reply, { status: 'error' }>): Optimizer {
  if (r.status === 'ask') return { ...o, phase: 'asking', pending: r.questions, answers: r.questions.map(() => ''), cur: 0, choice: 0, custom: '', error: '' }
  // The comment stays: it is the person's note on the whole job, not a one-off revision.
  return { ...o, phase: 'done', pending: [], answers: [], optimized: r.prompt, note: r.note, assumptions: r.assumptions, error: '' }
}

// How many rows a word-wrapped line takes at `width` cells; a word longer than a row spills over several.
function wrapped(line: string, width: number): number {
  let rows = 1
  let used = 0
  for (const word of line.split(' ')) {
    const gap = used === 0 ? 0 : 1
    if (used + gap + word.length <= width) {
      used += gap + word.length
      continue
    }
    if (used > 0) rows++
    rows += Math.floor(Math.max(0, word.length - 1) / width)
    used = word.length === 0 ? 0 : ((word.length - 1) % width) + 1
  }
  return rows
}

// Rows a text field needs for its text: it grows with the text up to 30% of the pane, then it scrolls inside.
// Never fewer than 2: the host draws one row as a single-line input, which drops pasted line breaks.
// The field's frame and padding take 4 columns; the desktop's proportional font gets 15% slack.
// shortcut: wraps are counted from the column count, not measured. A miss only makes the field scroll.
export function fieldRows(text: string, columns: number, paneRows: number, desktop: boolean): number {
  const width = Math.max(10, Math.floor((columns - 4) * (desktop ? 0.85 : 1)))
  const lines = text.split('\n').reduce((n, l) => n + wrapped(l, width), 0)
  return Math.max(2, Math.min(lines, Math.floor(paneRows * 0.3)))
}

export const choices = (q: Question) => q.options ?? [q.recommended]

// The answer for the question on screen. '' is the recommendation: Skip, or Next with the first option picked,
// so closeRound marks both as an accepted recommendation.
function given(o: Optimizer, q: Question, skip: boolean): string {
  if (skip) return ''
  const typed = o.custom.trim()
  if (typed !== '') return typed
  return o.choice === 0 ? '' : (choices(q)[o.choice] ?? '')
}

// The picked option and the field text for a question, from the answer saved on it.
function restore(q: Question | undefined, answer: string | undefined): Pick<Optimizer, 'choice' | 'custom'> {
  const a = answer ?? ''
  if (a === '' || q === undefined) return { choice: 0, custom: '' }
  const i = choices(q).indexOf(a)
  return i >= 0 ? { choice: i, custom: '' } : { choice: 0, custom: a }
}

// Next saves what is picked or typed on this question and shows the next one with what it already holds.
// Only this question's answer changes, so going back and forth never clears the others.
export function advance(o: Optimizer, skip: boolean): Optimizer {
  const q = o.pending[o.cur]
  if (o.phase !== 'asking' || q === undefined) return o
  const answers = o.pending.map((_, i) => (i === o.cur ? given(o, q, skip) : (o.answers[i] ?? '')))
  const cur = o.cur + 1
  return { ...o, answers, cur, ...restore(o.pending[cur], answers[cur]) }
}

// Back saves what is on screen, then shows the question before it with its saved answer.
// Past the last question (after a failed send) nothing is on screen, so there is nothing to save.
export function retreat(o: Optimizer): Optimizer {
  if (o.phase !== 'asking' || o.cur <= 0) return o
  const q = o.pending[o.cur]
  const answers = q === undefined ? o.answers : o.pending.map((_, i) => (i === o.cur ? given(o, q, false) : (o.answers[i] ?? '')))
  const cur = o.cur - 1
  return { ...o, answers, cur, ...restore(o.pending[cur], answers[cur]) }
}

// Every question is answered: the round can go to the model.
export const roundDone = (o: Optimizer) => o.phase === 'asking' && o.pending.length > 0 && o.cur >= o.pending.length

// An empty answer means "take your recommendation"; the model is told so it can list it as an assumption.
export function closeRound(o: Optimizer): Optimizer {
  if (o.pending.length === 0) return o
  const answers = o.pending.map((q, i) => (o.answers[i]?.trim() ? o.answers[i]!.trim() : `${q.recommended} (accepted recommendation)`))
  return { ...o, rounds: [...o.rounds, { questions: o.pending, answers }], pending: [], answers: [], cur: 0, choice: 0, custom: '' }
}

// The skill file's text without its front matter: the method the model follows.
export const skillBody = (md: string) => md.replace(/^---\n[\s\S]*?\n---\n/, '').trim()
