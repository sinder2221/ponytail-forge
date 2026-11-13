import { describe, expect, mock, test } from 'claude-code/testing'

import { EMPTY_OPT, MAX_ROUNDS, applyReply, buildPrompt, closeRound, parseReply, skillBody } from '../hooks/band/optimizer'
import type { Optimizer } from '../hooks/band/types'

const Q = { title: 'Audience', body: 'Who reads the result?', recommended: 'the finance team' }
const asking: Optimizer = { ...EMPTY_OPT, phase: 'asking', original: 'write a report', pending: [Q, { ...Q, title: 'Length' }], answers: ['', ' two pages '] }

describe('parseReply', () => {
  test('reads a done reply wrapped in a sentence', () => {
    const r = parseReply('Here you go: {"status":"done","prompt":"P","note":"n","assumptions":["a"]} bye')
    expect(r).toEqual({ status: 'done', prompt: 'P', note: 'n', assumptions: ['a'] })
  })

  test('keeps at most three questions and drops untitled ones', () => {
    const questions = [1, 2, 3, 4].map(i => ({ title: `t${i}`, body: 'b', recommended: 'r' }))
    const r = parseReply(JSON.stringify({ status: 'ask', questions: [{ body: 'no title' }, ...questions] }))
    expect(r.status === 'ask' && r.questions.length).toBe(3)
  })

  test('is an error for text without JSON, an empty prompt or no questions', () => {
    expect(parseReply('no json here').status).toBe('error')
    expect(parseReply('{"status":"done","prompt":"  "}').status).toBe('error')
    expect(parseReply('{"status":"ask","questions":[]}').status).toBe('error')
  })
})

describe('rounds', () => {
  test('an empty answer becomes the recommendation and is marked', () => {
    const o = closeRound(asking)
    expect(o.rounds[0]?.answers).toEqual(['the finance team (accepted recommendation)', 'two pages'])
    expect(o.pending).toEqual([])
  })

  test('buildPrompt carries the draft and the answered rounds', () => {
    const text = buildPrompt(closeRound(asking))
    expect(text).toContain('<original_prompt>\nwrite a report')
    expect(text).toContain('A: two pages')
  })

  test('questions are forbidden after the last round unless the person pushes', () => {
    let o = asking
    for (let i = 0; i < MAX_ROUNDS; i++) o = closeRound({ ...o, pending: [Q], answers: [''] })
    expect(buildPrompt(o)).toContain('No more questions are allowed')
    expect(buildPrompt(o, true)).toContain('grilled harder')
    expect(buildPrompt(o, true)).not.toContain('No more questions are allowed')
  })
})

describe('applyReply', () => {
  test('ask opens one empty answer per question', () => {
    const o = applyReply(EMPTY_OPT, { status: 'ask', questions: [Q, Q] })
    expect(o.phase).toBe('asking')
    expect(o.answers).toEqual(['', ''])
  })

  test('done keeps the prompt and ends the grill', () => {
    const o = applyReply(asking, { status: 'done', prompt: 'P', note: 'n', assumptions: ['a'] })
    expect([o.phase, o.optimized, o.pending]).toEqual(['done', 'P', []])
  })
})

test('skillBody drops the front matter', () => {
  expect(skillBody('---\nname: x\n---\nBody\n')).toBe('Body')
})

const PANE = {
  plugin: 'ponytail-forge',
  component: 'Pane',
  requestId: 'optimizer',
  surface: 'terminal',
  props: { title: 'Prompt optimizer', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} },
} as const

test('the panel grills, takes the recommendations and shows the forged prompt', async ($, on) => {
  mock.clock(on)
  mock.store(on)
  const replies: unknown[] = [
    { status: 'ask', questions: [{ title: 'Audience', body: 'Who reads it?', recommended: 'finance team' }] },
    { status: 'done', prompt: 'Write a two-page report for the finance team.', note: 'task first', assumptions: ['finance team'] },
  ]
  const asked: string[] = []
  on('prompt.read', () => ({ value: { text: 'write a report', cursor: 0 } }))
  on('fs.read', () => ({ value: '---\nname: x\n---\nMethod' }))
  on('model.fork', (_, e) => {
    asked.push(e.prompt)
    return { value: { isAnswered: true, text: JSON.stringify(replies.shift()), usage: {} } }
  })

  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'go' })
  expect(await ui.find({ type: 'Text', text: /Audience/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /write a report/ })).toBeDefined()

  await ui.press({ key: 'send' })
  expect(await ui.find({ type: 'Text', text: /two-page report/ })).toBeDefined()
  expect(asked[1]).toContain('finance team (accepted recommendation)')
  await ui.unmount()
})

test('closeRound with nothing pending changes nothing, so a double press adds no empty round', () => {
  expect(closeRound(EMPTY_OPT)).toBe(EMPTY_OPT)
})

test('a failed model call keeps the typed answers, and the same button retries', async ($, on) => {
  mock.clock(on)
  mock.store(on)
  const replies: unknown[] = [
    { isAnswered: true, text: JSON.stringify({ status: 'ask', questions: [{ title: 'Length', body: 'How long?', recommended: 'one page' }] }), usage: {} },
    { isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded', usage: {} },
    { isAnswered: true, text: JSON.stringify({ status: 'done', prompt: 'Write two pages.', note: '', assumptions: [] }), usage: {} },
  ]
  const asked: string[] = []
  on('prompt.read', () => ({ value: { text: 'write a report', cursor: 0 } }))
  on('fs.read', () => ({ value: '---\nname: x\n---\nMethod' }))
  on('model.fork', (_, e) => {
    asked.push(e.prompt)
    return { value: replies.shift() }
  })

  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'go' })
  await ui.input({ key: 'a0', text: 'two pages', kind: 'change' })
  await ui.press({ key: 'send' })
  expect(await ui.find({ type: 'Text', text: /model: api-error/ })).toBeDefined()
  // The question is still there and so is the send button.
  expect(await ui.find({ key: 'send' })).toBeDefined()

  await ui.press({ key: 'send' })
  expect(await ui.find({ type: 'Text', text: /Write two pages/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /model: api-error/ })).toBeUndefined()
  expect(asked[2]).toContain('A: two pages')
  await ui.unmount()
})
