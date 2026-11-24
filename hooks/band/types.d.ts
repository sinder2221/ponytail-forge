export type Tests = {
  state: 'none' | 'pass' | 'fail' | 'stale'
  passed?: number
  failed?: number
}

export type Tokens = { input: number; output: number; cacheRead: number; cacheWrite: number }

export type Band = {
  level: string
  model: string
  cost: number
  spent: number
  turns: number
  turnCosts: number[]
  tokens: Tokens
  busyMs: number
  name: string
  project: string
  session: string
  transcript: string
  reused: string[]
  created: string[]
  dupes: { name: string; like: string }[]
  removed: string[]
  openCallers: string[]
  tests: Tests
  details: boolean
}

// `options` holds the recommended answer first, then up to two alternatives.
export type Question = { title: string; body: string; recommended: string; options: string[] }

// A closed grill round: the questions and the answers given (an empty answer became the recommendation).
export type Round = { questions: Question[]; answers: string[] }

export type Optimizer = {
  on: boolean
  // Counts started steps: a slower reply from an older step is dropped.
  run: number
  phase: 'idle' | 'working' | 'asking' | 'done'
  original: string
  rounds: Round[]
  pending: Question[]
  // One answer per pending question, filled as the person moves on or back; '' means the recommendation.
  answers: string[]
  // The question on screen, the option picked on it (0 = recommended) and the text typed instead.
  cur: number
  choice: number
  custom: string
  // The person's comment on what the prompt is for and how the result should look (examples may be pasted in).
  // It goes with every step as context and stays until changed; Enter on a finished prompt also revises it by the comment.
  instruction: string
  optimized: string
  note: string
  assumptions: string[]
  error: string
}

declare module 'claude-code' {
  interface PluginState {
    'ponytail-forge': { band: Band; optimizer: Optimizer }
  }
}
