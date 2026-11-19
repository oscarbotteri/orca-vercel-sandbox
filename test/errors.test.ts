import { describe, expect, it } from 'vitest'
import { reasonOf } from '../src/errors.ts'

describe('reasonOf', () => {
  it('gives the message of a plain error', () => {
    expect(reasonOf(new Error('boom'))).toBe('boom')
  })

  it('adds the message of the cause, where fetch keeps its reason', () => {
    const error = new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED') })
    expect(reasonOf(error)).toBe('fetch failed: connect ECONNREFUSED')
  })

  it('ignores a cause that is not an error', () => {
    expect(reasonOf(new Error('boom', { cause: 'text' }))).toBe('boom')
  })

  it('prints a value that is not an error', () => {
    expect(reasonOf('plain text')).toBe('plain text')
  })
})
