import type { Optimizer, Question } from './types'

// The pure half of the prompt optimizer: what is asked of the model and what is made of its answer.
// shortcut: two grill rounds unless the person presses "Grill harder"; raise MAX_ROUNDS if that is too few.
export const MAX_ROUNDS = 2
export const MAX_QUESTIONS = 3

export const EMPTY_OPT: Optimizer = {
  on: false,
  run: 0,
  phase: 'idle',
  original: '',
  rounds: [],
  pending: [],
  answers: [],
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
Not enough is settled yet: {"status":"ask","questions":[{"title":"...","body":"...","recommended":"..."}]} with at most ${MAX_QUESTIONS} questions that do not depend on each other.
Everything is settled: {"status":"done","prompt":"<the optimized prompt, ready to paste>","note":"<one line: the strategy>","assumptions":["..."]}. List under assumptions every answer marked (accepted recommendation) and every gap you filled yourself.
Write questions and prompt in the language of the original prompt.`

// What one model call is asked: the draft, the rounds answered so far, and the reply format.
export function buildPrompt(o: Optimizer, push = false): string {
  const answered = o.rounds
    .map((r, i) => `Round ${i + 1}:\n${r.questions.map((q, j) => `Q: ${q.title}\nA: ${r.answers[j] ?? ''}`).join('\n')}`)
    .join('\n\n')
  const limit =
    push ? 'The person asked to be grilled harder: look for the weak points still left and ask again, unless there truly are none.'
    : o.rounds.length >= MAX_ROUNDS ? 'No more questions are allowed: reply with status "done" and list the gaps under assumptions.'
    : ''
  return [`<original_prompt>\n${o.original}\n</original_prompt>`, answered && `<answered_rounds>\n${answered}\n</answered_rounds>`, PROTOCOL, limit]
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
      .map((q: Record<string, unknown> | null) => ({ title: str(q?.title), body: str(q?.body), recommended: str(q?.recommended) }))
      .filter(q => q.title !== '')
      .slice(0, MAX_QUESTIONS)
    if (questions.length > 0) return { status: 'ask', questions }
  }
  return fail('The model answer had no questions and no prompt.')
}

// A failed reply never gets here: the caller keeps the state from before the step and shows the error.
export function applyReply(o: Optimizer, r: Exclude<Reply, { status: 'error' }>): Optimizer {
  if (r.status === 'ask') return { ...o, phase: 'asking', pending: r.questions, answers: r.questions.map(() => ''), error: '' }
  return { ...o, phase: 'done', pending: [], answers: [], optimized: r.prompt, note: r.note, assumptions: r.assumptions, error: '' }
}

// An empty answer means "take your recommendation"; the model is told so it can list it as an assumption.
export function closeRound(o: Optimizer): Optimizer {
  if (o.pending.length === 0) return o
  const answers = o.pending.map((q, i) => (o.answers[i]?.trim() ? o.answers[i]!.trim() : `${q.recommended} (accepted recommendation)`))
  return { ...o, rounds: [...o.rounds, { questions: o.pending, answers }], pending: [], answers: [] }
}

// The skill file's text without its front matter: the method the model follows.
export const skillBody = (md: string) => md.replace(/^---\n[\s\S]*?\n---\n/, '').trim()
