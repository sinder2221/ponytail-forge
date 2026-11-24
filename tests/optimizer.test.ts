import { describe, expect, mock, test } from 'claude-code/testing'

import { EMPTY_OPT, MAX_ROUNDS, advance, applyReply, buildPrompt, closeRound, fieldRows, parseReply, retreat, roundDone, skillBody } from '../hooks/band/optimizer'
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
  const on = { ...EMPTY_OPT, phase: 'asking' as const, pending: [Q, { ...Q, title: 'Length', recommended: 'one page', options: ['one page', 'two pages'] }], answers: ['', ''] }

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
    expect(closeRound(o).rounds[0]?.answers).toEqual(['the finance team (accepted recommendation)', 'one page (accepted recommendation)'])
  })

  test('outside a question it changes nothing', () => {
    expect(advance(EMPTY_OPT, false)).toBe(EMPTY_OPT)
    expect(advance(advance(advance(on, false), false), false).cur).toBe(2)
  })

  test('Next on the recommended option is an accepted recommendation, like Skip', () => {
    const o = advance(advance(on, false), false)
    expect(o.answers).toEqual(['', ''])
    expect(closeRound(o).rounds[0]?.answers).toEqual(['the finance team (accepted recommendation)', 'one page (accepted recommendation)'])
  })
})

describe('retreat', () => {
  const three = { ...EMPTY_OPT, phase: 'asking' as const, pending: [Q, { ...Q, title: 'Length', options: ['one page', 'two pages'], recommended: 'one page' }, { ...Q, title: 'Tone' }], answers: ['', '', ''] }

  test('Back shows the question before with its saved pick or typed text', () => {
    let o = advance({ ...three, choice: 1 }, false)
    o = advance({ ...o, custom: 'my own length' }, false)
    expect([o.cur, o.choice, o.custom]).toEqual([2, 0, ''])
    o = retreat(o)
    expect([o.cur, o.choice, o.custom]).toEqual([1, 0, 'my own length'])
    o = retreat(o)
    expect([o.cur, o.choice, o.custom]).toEqual([0, 1, ''])
  })

  test('Back saves what is on screen first', () => {
    const o = retreat({ ...advance(three, false), custom: 'half typed' })
    expect(o.answers).toEqual(['', 'half typed', ''])
    expect(advance(o, false).custom).toBe('half typed')
  })

  test('changing an earlier answer keeps the later ones, which come back when walking forward', () => {
    let o = advance({ ...three, choice: 1 }, false)
    o = advance({ ...o, custom: 'two and a half pages' }, false)
    o = retreat(retreat(o))
    o = advance({ ...o, choice: 0 }, false)
    expect(o.answers).toEqual(['', 'two and a half pages', ''])
    expect([o.cur, o.custom]).toEqual([1, 'two and a half pages'])
    o = advance(o, false)
    o = advance(o, false)
    expect(roundDone(o)).toBe(true)
    expect(closeRound(o).rounds[0]?.answers[1]).toBe('two and a half pages')
  })

  test('on the first question or outside a question it changes nothing', () => {
    expect(retreat(three)).toBe(three)
    expect(retreat(EMPTY_OPT)).toBe(EMPTY_OPT)
    expect(retreat({ ...three, phase: 'working', cur: 1 }).cur).toBe(1)
  })

  test('after a failed send, past the last question, Back opens the last question', () => {
    const sent = { ...three, answers: ['', 'one page', 'a tone'], cur: 3 }
    const o = retreat(sent)
    expect([o.cur, o.answers, o.custom]).toEqual([2, ['', 'one page', 'a tone'], 'a tone'])
  })
})

describe('comment', () => {
  const done = { ...EMPTY_OPT, phase: 'done' as const, original: 'draft', optimized: 'Prompt v1', instruction: ' for the board, one page ' }

  test('goes with every step as context, trimmed, and an empty one adds nothing', () => {
    const text = buildPrompt(done)
    expect(text).toContain('<comment>\nfor the board, one page\n</comment>')
    expect(text).toContain('never copy it into the prompt word for word')
    expect(text).not.toContain('<optimized_prompt>')
    expect(buildPrompt(done, true)).toContain('<comment>')
    expect(buildPrompt({ ...done, instruction: '  ' })).not.toContain('<comment>')
  })

  test('comes after the draft and before the answered rounds', () => {
    const text = buildPrompt(closeRound({ ...asking, instruction: 'a note' }))
    const at = (s: string) => text.indexOf(s)
    expect(at('<original_prompt>')).toBeLessThan(at('<comment>'))
    expect(at('<comment>')).toBeLessThan(at('<answered_rounds>'))
  })

  test('revise also asks to rewrite the optimized prompt by it, and only when there is a comment', () => {
    const text = buildPrompt(done, false, true)
    expect(text).toContain('<optimized_prompt>\nPrompt v1')
    expect(text).toContain('revise the optimized prompt')
    expect(buildPrompt({ ...done, instruction: '' }, false, true)).not.toContain('<optimized_prompt>')
  })

  test('a done reply keeps it, and an ask reply keeps it for the rounds that follow', () => {
    const o = { ...EMPTY_OPT, instruction: 'shorter', optimized: 'v1' }
    expect(applyReply(o, { status: 'done', prompt: 'v2', note: '', assumptions: [] }).instruction).toBe('shorter')
    expect(applyReply(o, { status: 'ask', questions: [Q] }).instruction).toBe('shorter')
  })

  test('pasted examples: the protocol says what they are, and a multi-line answer is fenced', () => {
    const text = buildPrompt(closeRound({ ...asking, answers: ['line one\nline two', 'two pages'] }))
    expect(text).toContain('example material')
    expect(text).toContain('A:\n"""\nline one\nline two\n"""')
    expect(text).toContain('A: two pages')
  })
})

describe('fieldRows', () => {
  const rows = (text: string, desktop = false) => fieldRows(text, 60, 20, desktop)

  test('at least two rows, so the host draws a textarea that keeps pasted line breaks', () => {
    expect(rows('')).toBe(2)
    expect(rows('short')).toBe(2)
    expect(fieldRows('x\ny', 60, 1, false)).toBe(2)
  })

  test('grows as the text wraps by word and breaks lines', () => {
    expect(rows('x'.repeat(112))).toBe(2)
    expect(rows('x'.repeat(113))).toBe(3)
    expect(rows('a\nb\nc')).toBe(3)
    // Three 30-letter words need a row each; counting letters would say two.
    expect(rows(['a', 'b', 'c'].map(c => c.repeat(30)).join(' '))).toBe(3)
  })

  test('stops growing at 30% of the pane rows, however long the text', () => {
    expect(rows('word '.repeat(2000))).toBe(6)
    expect(fieldRows('word '.repeat(2000), 60, 50, false)).toBe(15)
  })

  test('the desktop counts a wrap sooner', () => {
    expect(rows('x'.repeat(100))).toBe(2)
    expect(rows('x'.repeat(100), true)).toBe(3)
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
// One prop of the element with this key, as the pane drew it.
const propOf = async (ui: { find: (m: { key: string }) => Promise<unknown> }, key: string, prop: string) =>
  ((await ui.find({ key })) as { props?: Record<string, unknown> } | undefined)?.props?.[prop]

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

test('Enter in the comment field rewrites a finished prompt by it; Grill harder sends it as context only', async ($, on) => {
  mock.clock(on)
  mock.store(on)
  const { asked, replies } = model(on)
  for (const surface of SURFACES) {
    asked.length = 0
    replies.push(answered(done('Long prompt.')), answered(done('Short prompt.')), answered(done('Shorter prompt.')))
    const ui = await $.ui.mount({ ...PANE, surface })
    // The state outlives the mount: start each surface with an empty comment.
    await ui.input({ key: 'instruction', text: '', kind: 'change' })
    await ui.press({ key: 'go' })
    expect(asked[0]).not.toContain('<comment>')
    // An empty field does nothing: no model call.
    await ui.input({ key: 'instruction', text: '  ', kind: 'submit' })
    expect(asked.length).toBe(1)

    await ui.input({ key: 'instruction', text: 'make it shorter', kind: 'change' })
    await ui.input({ key: 'instruction', text: 'make it shorter', kind: 'submit' })
    expect(await ui.find({ type: 'Text', text: /Short prompt/ })).toBeDefined()
    expect(asked[1]).toContain('<optimized_prompt>\nLong prompt.')
    expect(asked[1]).toContain('<comment>\nmake it shorter')
    // The comment stays in the field and goes on as context, without a rewrite.
    expect(await propOf(ui, 'instruction', 'value')).toBe('make it shorter')
    await ui.press({ key: 'harder' })
    expect(asked[2]).toContain('<comment>\nmake it shorter')
    expect(asked[2]).not.toContain('<optimized_prompt>')
    expect(asked[2]).toContain('grilled harder')
    await ui.unmount()
  }
})

test('a comment typed before Optimize draft reaches every step and survives Start over', async ($, on) => {
  mock.clock(on)
  mock.store(on)
  const { asked, replies } = model(on)
  for (const surface of SURFACES) {
    asked.length = 0
    replies.push(answered(ask('Audience')), answered(done('P')), answered(ask('Length')))
    const ui = await $.ui.mount({ ...PANE, surface })
    // The field is live before there is anything to revise.
    await ui.input({ key: 'instruction', text: 'for the board, one page', kind: 'change' })
    expect(await propOf(ui, 'instruction', 'value')).toBe('for the board, one page')
    await ui.press({ key: 'go' })
    expect(asked[0]).toContain('<comment>\nfor the board, one page')
    await ui.press({ key: 'skip' })
    expect(asked[1]).toContain('<comment>\nfor the board, one page')
    expect(await propOf(ui, 'instruction', 'value')).toBe('for the board, one page')
    await ui.press({ key: 'go' })
    expect(asked[2]).toContain('<comment>\nfor the board, one page')
    expect(asked[2]).not.toContain('<answered_rounds>')
    await ui.unmount()
  }
})

test('closeRound with nothing pending changes nothing, so a double press adds no empty round', () => {
  expect(closeRound(EMPTY_OPT)).toBe(EMPTY_OPT)
})

test('the answer and comment fields start at two rows, grow with the text, stop at 30% of the pane and shrink when cleared', async ($, on) => {
  mock.clock(on)
  mock.store(on)
  const { replies } = model(on)
  for (const surface of SURFACES) {
    replies.push(answered(ask('Audience')))
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'go' })
    for (const key of ['custom', 'instruction']) {
      expect(await propOf(ui, key, 'rows')).toBe(2)
      await ui.input({ key, text: 'a short answer', kind: 'change' })
      expect(await propOf(ui, key, 'rows')).toBe(2)
      await ui.input({ key, text: 'a longer answer that wraps over several lines of the pane. '.repeat(4), kind: 'change' })
      const long = (await propOf(ui, key, 'rows')) as number
      expect(long).toBeGreaterThan(2)
      expect(long).toBeLessThanOrEqual(6)
      await ui.input({ key, text: 'a very long answer. '.repeat(500), kind: 'change' })
      expect(await propOf(ui, key, 'rows')).toBe(6)
      await ui.input({ key, text: '', kind: 'change' })
      expect(await propOf(ui, key, 'rows')).toBe(2)
    }
    await ui.unmount()
  }
})

test('the bar has the same buttons and field in every phase, and the dimmed ones do nothing before a result', async ($, on) => {
  mock.clock(on)
  mock.store(on)
  let filled = 0
  on('prompt.fill', () => {
    filled++
    return { isFilled: true as const }
  })
  on('ui.copy', () => ({ value: { isCopied: true as const } }))
  on('ui.toast', () => ({ value: undefined }))
  const { replies } = model(on)
  for (const surface of SURFACES) {
    replies.push(answered(ask('Audience')), answered(done('Prompt.')))
    const ui = await $.ui.mount({ ...PANE, surface })
    const bar = async () => (await Promise.all(['go', 'use', 'copy', 'instruction', 'harder'].map(key => ui.find({ key })))).every(x => x !== undefined)
    expect(await bar()).toBe(true)
    // The state outlives the mount, so only the first surface starts with no result.
    if (surface === 'terminal') {
      await ui.press({ key: 'use' })
      await ui.press({ key: 'harder' })
      await ui.input({ key: 'instruction', text: 'too early', kind: 'submit' })
      expect(filled).toBe(0)
      expect(await ui.find({ type: 'Text', text: /Ingen prompt endnu/ })).toBeDefined()
    }

    await ui.press({ key: 'go' })
    expect(await bar()).toBe(true)
    expect(await ui.find({ key: 'skip' })).toBeDefined()
    await ui.press({ key: 'skip' })
    expect(await bar()).toBe(true)
    expect(await ui.find({ type: 'Text', text: /^Prompt\.$/ })).toBeDefined()
    await ui.press({ key: 'use' })
    expect(filled).toBe(1)
    filled = 0
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

test('Back walks to the earlier questions with their answers, and changing one keeps the later ones', async ($, on) => {
  mock.clock(on)
  mock.store(on)
  const { asked, replies } = model(on)
  for (const surface of SURFACES) {
    asked.length = 0
    replies.push(answered(ask('Audience', 'Length', 'Tone')), answered(done('P')))
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'go' })
    // On the first question Back does nothing.
    await ui.press({ key: 'back' })
    expect(await ui.find({ type: 'Text', text: /1\/3/ })).toBeDefined()
    await ui.press({ key: 'opt-1' })
    await ui.press({ key: 'next' })
    await ui.input({ key: 'custom', text: 'two pages', kind: 'change' })
    await ui.press({ key: 'next' })
    expect(await ui.find({ type: 'Text', text: /3\/3/ })).toBeDefined()
    // The last question sends the round, and says so.
    expect(await propOf(ui, 'next', 'label')).toBe('Send')

    await ui.press({ key: 'back' })
    expect(await propOf(ui, 'custom', 'value')).toBe('two pages')
    await ui.press({ key: 'back' })
    expect(await ui.find({ type: 'Text', text: /1\/3/ })).toBeDefined()
    expect(await propOf(ui, 'opt-1', 'label')).toBe('(•)')

    // Change the first answer: the later ones are still there when walking forward.
    await ui.press({ key: 'opt-0' })
    await ui.press({ key: 'next' })
    expect(await propOf(ui, 'custom', 'value')).toBe('two pages')
    await ui.press({ key: 'next' })
    expect(asked.length).toBe(1)
    await ui.press({ key: 'next' })
    expect(asked[1]).toContain('A: Audience rec (accepted recommendation)')
    expect(asked[1]).toContain('A: two pages')
    expect(asked[1]).toContain('A: Tone rec (accepted recommendation)')
    await ui.unmount()
  }
})

test('after a failed send Back reopens the last question with its answer', async ($, on) => {
  mock.clock(on)
  mock.store(on)
  const { asked, replies } = model(on)
  replies.push(answered(ask('Length')), { isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded', usage: {} }, answered(done('Write two pages.')))
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'go' })
  await ui.input({ key: 'custom', text: 'two pages', kind: 'change' })
  await ui.press({ key: 'next' })
  expect(await ui.find({ key: 'retry' })).toBeDefined()
  expect(await ui.find({ key: 'back' })).toBeDefined()

  await ui.press({ key: 'back' })
  expect(await ui.find({ key: 'retry' })).toBeUndefined()
  expect(await propOf(ui, 'custom', 'value')).toBe('two pages')
  await ui.press({ key: 'next' })
  expect(await ui.find({ type: 'Text', text: /Write two pages/ })).toBeDefined()
  expect(asked[2]).toContain('A: two pages')
  await ui.unmount()
})

test('a long suggestion is plain wrapping text beside a small pick button, so it shows in full and can be selected', async ($, on) => {
  mock.clock(on)
  mock.store(on)
  const { replies } = model(on)
  const long = 'a very long suggestion that must not be cut off '.repeat(8).trim()
  const reply = JSON.stringify({ status: 'ask', questions: [{ title: 'Audience', body: 'Who?', recommended: long, options: [long, 'short one'] }] })
  for (const surface of SURFACES) {
    replies.push(answered(reply))
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'go' })
    const text = (await ui.find({ type: 'Text', text: /very long suggestion/ })) as { props?: Record<string, unknown> } | undefined
    expect(text).toBeDefined()
    expect(text?.props?.maxLines).toBeUndefined()
    expect([undefined, 'wrap']).toContain(text?.props?.wrap)
    // The pick button carries a marker, never the suggestion itself.
    expect(await propOf(ui, 'opt-0', 'label')).toBe('(•)')
    expect(await propOf(ui, 'opt-1', 'label')).toBe('( )')
    await ui.press({ key: 'opt-1' })
    expect(await propOf(ui, 'opt-0', 'label')).toBe('( )')
    expect(await propOf(ui, 'opt-1', 'label')).toBe('(•)')
    await ui.unmount()
  }
})

test('a pasted multi-line answer reaches the model fenced, with its line breaks', async ($, on) => {
  mock.clock(on)
  mock.store(on)
  const { asked, replies } = model(on)
  replies.push(answered(ask('Audience')), answered(done('P')))
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'go' })
  await ui.input({ key: 'custom', text: 'Dear board,\nHere is the report.', kind: 'change' })
  await ui.press({ key: 'next' })
  expect(asked[1]).toContain('A:\n"""\nDear board,\nHere is the report.\n"""')
  await ui.unmount()
})
