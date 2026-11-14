import { describe, expect, mock, test } from 'claude-code/testing'

import { EMPTY_OPT, MAX_ROUNDS, advance, applyReply, buildPrompt, closeRound, fieldRows, parseReply, roundDone, skillBody } from '../hooks/band/optimizer'
import type { Optimizer } from '../hooks/band/types'

const Q = { title: 'Audience', body: 'Who reads the result?', recommended: 'the finance team', options: ['the finance team', 'the board'] }
const asking: Optimizer = { ...EMPTY_OPT, phase: 'asking', original: 'write a report', pending: [Q, { ...Q, title: 'Length' }], answers: ['', ' two pages '], cur: 2 }

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

describe('options', () => {
  const ask = (q: unknown) => parseReply(JSON.stringify({ status: 'ask', questions: [q] }))

  test('the recommended answer leads, duplicates go and at most three stay', () => {
    const r = ask({ title: 't', recommended: 'A', options: ['B', 'A', 'C', 'D'] })
    expect(r.status === 'ask' && r.questions[0]?.options).toEqual(['A', 'B', 'C'])
  })

  test('without a recommended answer the first option stands in, without options the recommended one is the only choice', () => {
    const a = ask({ title: 't', options: ['B', 'C'] })
    expect(a.status === 'ask' && [a.questions[0]?.recommended, a.questions[0]?.options]).toEqual(['B', ['B', 'C']])
    const b = ask({ title: 't', recommended: 'A' })
    expect(b.status === 'ask' && b.questions[0]?.options).toEqual(['A'])
  })
})

describe('advance', () => {
  const on = { ...EMPTY_OPT, phase: 'asking' as const, pending: [Q, { ...Q, title: 'Length', options: ['one page', 'two pages'] }], answers: ['', ''] }

  test('Next saves the picked option and moves to the next question', () => {
    const o = advance({ ...on, choice: 1 }, false)
    expect([o.answers, o.cur, o.choice, roundDone(o)]).toEqual([['the board', ''], 1, 0, false])
  })

  test('typed text beats the picked option', () => {
    expect(advance({ ...on, choice: 1, custom: ' my own ' }, false).answers[0]).toBe('my own')
  })

  test('Skip saves nothing, so the round closes it as the recommendation', () => {
    const o = advance(advance({ ...on, choice: 1 }, true), false)
    expect(roundDone(o)).toBe(true)
    expect(closeRound(o).rounds[0]?.answers).toEqual(['the finance team (accepted recommendation)', 'one page'])
  })

  test('outside a question it changes nothing', () => {
    expect(advance(EMPTY_OPT, false)).toBe(EMPTY_OPT)
    expect(advance(advance(advance(on, false), false), false).cur).toBe(2)
  })
})

describe('instruction', () => {
  test('is sent with the optimized prompt it revises, and only when there is one', () => {
    const done = { ...EMPTY_OPT, phase: 'done' as const, original: 'draft', optimized: 'Prompt v1' }
    expect(buildPrompt(done)).not.toContain('<instruction>')
    const text = buildPrompt({ ...done, instruction: ' shorter ' })
    expect(text).toContain('<optimized_prompt>\nPrompt v1')
    expect(text).toContain('<instruction>\nshorter\n</instruction>')
  })

  test('a done reply uses it up, an ask reply keeps it for the rounds that follow', () => {
    const o = { ...EMPTY_OPT, instruction: 'shorter', optimized: 'v1' }
    expect(applyReply(o, { status: 'done', prompt: 'v2', note: '', assumptions: [] }).instruction).toBe('')
    expect(applyReply(o, { status: 'ask', questions: [Q] }).instruction).toBe('shorter')
  })
})

describe('fieldRows', () => {
  const rows = (text: string, desktop = false) => fieldRows(text, 60, 20, desktop)

  test('one line for short or empty text, more as it wraps and breaks lines', () => {
    expect(rows('')).toBe(1)
    expect(rows('short')).toBe(1)
    expect(rows('x'.repeat(112))).toBe(2)
    expect(rows('a\nb\nc')).toBe(3)
  })

  test('stops growing at 40% of the pane rows, however long the text', () => {
    expect(rows('word '.repeat(2000))).toBe(8)
    expect(fieldRows('word '.repeat(2000), 60, 50, false)).toBe(20)
  })

  test('the desktop counts a wrap sooner, and a tiny pane still shows one row', () => {
    expect(rows('x'.repeat(50))).toBe(1)
    expect(rows('x'.repeat(50), true)).toBe(2)
    expect(fieldRows('x\ny', 60, 1, false)).toBe(1)
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

const SURFACES = ['terminal', 'desktop'] as const
const PANE = {
  plugin: 'ponytail-forge',
  component: 'Pane',
  requestId: 'optimizer',
  props: { title: 'Prompt optimizer', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} },
} as const
const ask = (...titles: string[]) =>
  JSON.stringify({ status: 'ask', questions: titles.map(t => ({ title: t, body: `${t}?`, recommended: `${t} rec`, options: [`${t} rec`, `${t} alt`] })) })
const done = (prompt: string) => JSON.stringify({ status: 'done', prompt, note: 'task first', assumptions: ['finance team'] })
const answered = (text: string) => ({ isAnswered: true, text, usage: {} })

// A model that answers from a list, with the prompts it was asked.
// The queue is filled again for each surface: hooks can only be registered once per test.
function model(on: Parameters<Parameters<typeof test>[1]>[1]) {
  const asked: string[] = []
  const replies: unknown[] = []
  on('prompt.read', () => ({ value: { text: 'write a report', cursor: 0 } }))
  on('fs.read', () => ({ value: '---\nname: x\n---\nMethod' }))
  on('model.fork', (_, e) => {
    asked.push(e.prompt)
    return { value: replies.shift() }
  })
  return { asked, replies }
}

test('one question per screen: Next saves the pick or the typed text, and the last one sends the round', async ($, on) => {
  mock.clock(on)
  mock.store(on)
  const { asked, replies } = model(on)
  for (const surface of SURFACES) {
    asked.length = 0
    replies.push(answered(ask('Audience', 'Length')), answered(done('Write a two-page report for the board.')))
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'go' })
    expect(await ui.find({ type: 'Text', text: /Audience/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /1\/2/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Length/ })).toBeUndefined()
    expect(await ui.find({ key: 'opt-0' })).toBeDefined()
    expect(await ui.find({ key: 'opt-1' })).toBeDefined()
    expect(await ui.find({ key: 'opt-2' })).toBeUndefined()
    expect(await ui.find({ key: 'custom' })).toBeDefined()

    await ui.press({ key: 'opt-1' })
    await ui.press({ key: 'next' })
    expect(await ui.find({ type: 'Text', text: /Length/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /2\/2/ })).toBeDefined()
    // Nothing went to the model between the two questions.
    expect(asked.length).toBe(1)

    await ui.input({ key: 'custom', text: 'two pages', kind: 'change' })
    await ui.press({ key: 'next' })
    expect(await ui.find({ type: 'Text', text: /two-page report/ })).toBeDefined()
    expect(asked[1]).toContain('A: Audience alt')
    expect(asked[1]).toContain('A: two pages')
    expect(asked[1]).not.toContain('(accepted recommendation)\nQ:')
    await ui.unmount()
  }
})

test('Skip takes the recommendation, marks it, and an Enter in the field is Next', async ($, on) => {
  mock.clock(on)
  mock.store(on)
  const { asked, replies } = model(on)
  for (const surface of SURFACES) {
    asked.length = 0
    replies.push(answered(ask('Audience', 'Length')), answered(done('P')))
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'go' })
    await ui.press({ key: 'skip' })
    expect(await ui.find({ type: 'Text', text: /Length/ })).toBeDefined()
    await ui.input({ key: 'custom', text: 'one page', kind: 'submit' })
    expect(await ui.find({ type: 'Text', text: /^P$/ })).toBeDefined()
    expect(asked[1]).toContain('A: Audience rec (accepted recommendation)')
    expect(asked[1]).toContain('A: one page')
    await ui.unmount()
  }
})

test('the finished view hides the original and shows the prompt, the note and the assumptions', async ($, on) => {
  mock.clock(on)
  mock.store(on)
  const { replies } = model(on)
  for (const surface of SURFACES) {
    replies.push(answered(done('Write a two-page report for the finance team.')))
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'go' })
    expect(await ui.find({ type: 'Text', text: /two-page report/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /task first/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /finance team$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /write a report/ })).toBeUndefined()
    for (const key of ['use', 'copy', 'harder', 'instruction', 'go']) expect(await ui.find({ key })).toBeDefined()
    await ui.unmount()
  }
})

test('the instruction field revises the optimized prompt on the next step, and is used up', async ($, on) => {
  mock.clock(on)
  mock.store(on)
  const { asked, replies } = model(on)
  for (const surface of SURFACES) {
    asked.length = 0
    replies.push(answered(done('Long prompt.')), answered(done('Short prompt.')), answered(done('Shorter prompt.')))
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'go' })
    // An empty field does nothing: no model call.
    await ui.input({ key: 'instruction', text: '  ', kind: 'submit' })
    expect(asked.length).toBe(1)

    await ui.input({ key: 'instruction', text: 'make it shorter', kind: 'change' })
    await ui.input({ key: 'instruction', text: 'make it shorter', kind: 'submit' })
    expect(await ui.find({ type: 'Text', text: /Short prompt/ })).toBeDefined()
    expect(asked[1]).toContain('<optimized_prompt>\nLong prompt.')
    expect(asked[1]).toContain('make it shorter')
    // The instruction is gone from the field and from the next step.
    await ui.press({ key: 'harder' })
    expect(asked[2]).not.toContain('make it shorter')
    expect(asked[2]).toContain('grilled harder')
    await ui.unmount()
  }
})

test('closeRound with nothing pending changes nothing, so a double press adds no empty round', () => {
  expect(closeRound(EMPTY_OPT)).toBe(EMPTY_OPT)
})

test('the answer field grows with the typed text, stops at 40% of the pane and shrinks when cleared', async ($, on) => {
  mock.clock(on)
  mock.store(on)
  const { replies } = model(on)
  const rowsOf = async (ui: Awaited<ReturnType<typeof $.ui.mount>>, key: string) => ((await ui.find({ key })) as { props?: { rows?: number } } | undefined)?.props?.rows
  for (const surface of SURFACES) {
    replies.push(answered(ask('Audience')))
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'go' })
    expect(await rowsOf(ui, 'custom')).toBe(1)
    await ui.input({ key: 'custom', text: 'a short answer', kind: 'change' })
    expect(await rowsOf(ui, 'custom')).toBe(1)
    await ui.input({ key: 'custom', text: 'a longer answer that wraps over several lines of the pane. '.repeat(4), kind: 'change' })
    const long = await rowsOf(ui, 'custom')
    expect(long).toBeGreaterThan(1)
    expect(long).toBeLessThanOrEqual(8)
    await ui.input({ key: 'custom', text: 'a very long answer. '.repeat(500), kind: 'change' })
    expect(await rowsOf(ui, 'custom')).toBe(8)
    await ui.input({ key: 'custom', text: '', kind: 'change' })
    expect(await rowsOf(ui, 'custom')).toBe(1)
    await ui.unmount()
  }
})

test('a failed model call keeps the answers, and the same button retries', async ($, on) => {
  mock.clock(on)
  mock.store(on)
  const { asked, replies } = model(on)
  replies.push(
    answered(ask('Length')),
    { isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded', usage: {} },
    answered(done('Write two pages.'))
  )
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'go' })
  await ui.input({ key: 'custom', text: 'two pages', kind: 'change' })
  await ui.press({ key: 'next' })
  expect(await ui.find({ type: 'Text', text: /model: api-error/ })).toBeDefined()
  // No question is left on screen, so the way on is the retry button.
  expect(await ui.find({ key: 'custom' })).toBeUndefined()
  expect(await ui.find({ key: 'retry' })).toBeDefined()

  await ui.press({ key: 'retry' })
  expect(await ui.find({ type: 'Text', text: /Write two pages/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /model: api-error/ })).toBeUndefined()
  expect(asked[2]).toContain('A: two pages')
  await ui.unmount()
})
