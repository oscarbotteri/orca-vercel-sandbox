import { describe, expect, it } from 'vitest'
import { resolveCredentials } from '../src/credentials.ts'
import { UserError } from '../src/errors.ts'

const complete = {
  VERCEL_TOKEN: 'vcp_abcdefghijklmnopqrstuvwxyz',
  VERCEL_TEAM_ID: 'team_abc123',
  VERCEL_PROJECT_ID: 'prj_abc123',
}

describe('resolveCredentials', () => {
  it('returns the token, team and project from the environment', () => {
    expect(resolveCredentials(complete)).toEqual({
      token: 'vcp_abcdefghijklmnopqrstuvwxyz',
      teamId: 'team_abc123',
      projectId: 'prj_abc123',
    })
  })

  it('trims surrounding whitespace, as a shell profile export may leave it', () => {
    const found = resolveCredentials({ ...complete, VERCEL_TEAM_ID: ' team_abc123\n' })
    expect(found.teamId).toBe('team_abc123')
  })

  it('names every missing variable at once and how to set them', () => {
    const error = catchError(() => resolveCredentials({}))
    expect(error).toBeInstanceOf(UserError)
    for (const name of ['VERCEL_TOKEN', 'VERCEL_TEAM_ID', 'VERCEL_PROJECT_ID']) {
      expect(error.message).toContain(name)
    }
    expect(error.message).toContain('shell profile')
  })

  it('treats a blank variable as missing', () => {
    const error = catchError(() => resolveCredentials({ ...complete, VERCEL_PROJECT_ID: '  ' }))
    expect(error.message).toContain('VERCEL_PROJECT_ID is not set')
    expect(error.message).not.toContain('VERCEL_TOKEN')
  })

  it.each([
    ['VERCEL_TOKEN', 'vcp_abc def'],
    ['VERCEL_TEAM_ID', 'team_abc\u0000'],
    ['VERCEL_PROJECT_ID', 'prj_a\tb'],
    ['VERCEL_TOKEN', 'vcp_abc\u007fdef'],
    ['VERCEL_TOKEN', 'vcp_abc\u200bdef'],
    ['VERCEL_TEAM_ID', '\u201cteam_abc\u201d'],
  ])('rejects %s with a space, control or non-ASCII character inside', (name, value) => {
    const error = catchError(() => resolveCredentials({ ...complete, [name]: value }))
    expect(error.message).toContain(`${name} is not valid`)
  })

  it('never puts the token in an error message', () => {
    const token = 'vcp_secret token'
    const error = catchError(() => resolveCredentials({ ...complete, VERCEL_TOKEN: token }))
    expect(error.message).not.toContain(token)
    expect(error.message).not.toContain('secret')
  })
})

function catchError(fn: () => unknown): Error {
  try {
    fn()
  } catch (error) {
    return error as Error
  }
  throw new Error('expected a throw')
}
