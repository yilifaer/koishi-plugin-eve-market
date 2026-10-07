import { describe, expect, it } from 'vitest'
import { APPRAISAL_ID_ALPHABET, APPRAISAL_ID_MAX } from '../../../src/constants'
import { APPRAISAL_STORE_KEY, APPRAISAL_TTL_MS } from '../../../src/core/appraisal'
import type { ItemList } from '../../../src/core/appraisal/lines'
import { SavedAppraisals } from '../../../src/core/appraisal/saved'
import { createModuleStore } from '../../../src/core/ports'
import { parseAppraisalId } from '../../../src/core/parse'
import { FakeTime } from '../../fakes/fake-time'

const LIST: ItemList = { format: 'lines', fittings: [], entries: [], skipped: [], truncated: 0 }
const SPACE = APPRAISAL_ID_ALPHABET.length ** 4

function saved(random: () => number = Math.random) {
  const time = new FakeTime()
  const store = createModuleStore()
  return { time, store, saved: new SavedAppraisals(store, time, random) }
}

describe('appraisal ids', () => {
  it('are 4 characters from the safe alphabet with at least one letter, and parse back from a header', () => {
    const { saved: s } = saved()
    for (let i = 0; i < 300; i++) {
      const { id } = s.save(LIST)
      expect(id).toMatch(new RegExp(`^[${APPRAISAL_ID_ALPHABET}]{4}$`))
      expect(id).toMatch(/[A-Z]/)
      expect(parseAppraisalId(`#${id}`)).toBe(id)
    }
  })

  it('never hands out an id that is still in use, and skips all-digit ids', () => {
    const { saved: s } = saved(() => 0.5)
    const ids = Array.from({ length: 50 }, () => s.save(LIST).id)
    expect(new Set(ids).size).toBe(50)
    // 第一个随机数落在「2222」上：全是数字，往后找到第一个带字母的
    const digits = APPRAISAL_ID_ALPHABET.indexOf('2')
    const n = ((digits * 32 + digits) * 32 + digits) * 32 + digits
    const { saved: d } = saved(() => (n + 0.5) / SPACE)
    expect(d.save(LIST).id).toBe('223A')
  })

  it('survive a broken random source', () => {
    const { saved: s } = saved(() => Number.NaN)
    expect(s.save(LIST).id).toBe('AAAA')
    expect(s.save(LIST).id).toBe('AAAB')
  })
})

describe('saved appraisals', () => {
  it('expire after the TTL without use; reading one restarts its clock', async () => {
    const { time, saved: s } = saved()
    const { id } = s.save(LIST)
    await time.advance(APPRAISAL_TTL_MS - 1)
    expect(s.get(id)).toBeDefined()
    await time.advance(APPRAISAL_TTL_MS - 1)
    expect(s.get(id.toLowerCase())).toBeDefined()
    await time.advance(APPRAISAL_TTL_MS)
    expect(s.get(id)).toBeUndefined()
  })

  it('keep at most APPRAISAL_ID_MAX lists, least recently used first out', () => {
    const { saved: s } = saved()
    const ids = Array.from({ length: APPRAISAL_ID_MAX }, () => s.save(LIST).id)
    expect(s.get(ids[0])).toBeDefined()
    s.save(LIST)
    expect(s.get(ids[0])).toBeDefined()
    expect(s.get(ids[1])).toBeUndefined()
  })

  it('live in the module store, shared by every instance built on it', () => {
    const { time, store, saved: s } = saved()
    const { id } = s.save(LIST, { side: 'buy' })
    const other = new SavedAppraisals(store, time, Math.random)
    expect(other.get(id)?.params).toEqual({ side: 'buy' })
    expect(store.get(APPRAISAL_STORE_KEY, () => null)).not.toBeNull()
  })
})
