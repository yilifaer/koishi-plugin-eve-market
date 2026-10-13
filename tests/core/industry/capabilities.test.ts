import { describe, expect, it } from 'vitest'
import { capabilityVerdict, needLabel, servicesFor, structureServices } from '../../../src/core/industry/capabilities'
import type { ServiceInfo, StructureTypeInfo } from '../../../src/core/types'

const RAITARU = 35825, AZBEL = 35826, SOTIYO = 35827, ATHANOR = 35835
const CARRIER = { groupId: 547, categoryId: 6 }
const SUPERCARRIER = { groupId: 659, categoryId: 6 }
const FREIGHTER = { groupId: 513, categoryId: 6 }
const FRIGATE = { groupId: 25, categoryId: 6 }
const POLYMER = { groupId: 4764, categoryId: 4 }
const ODD = { groupId: 1194, categoryId: 99 }

const secAll = { h: true, l: true, n: true }
const services: ServiceInfo[] = [
  { id: 1, key: 'manufacturing', en: 'Standup Manufacturing Plant I', zh: '屹立制造厂 I', activity: 'm',
    groups: [25, 513, 902, 941], categories: [7], fitGroups: [1404, 1657], fitTypes: [], sec: secAll },
  { id: 2, key: 'capital', en: 'Standup Capital Shipyard I', zh: '屹立旗舰级船坞 I', activity: 'm',
    groups: [547, 485], categories: [], fitGroups: [], fitTypes: [AZBEL, SOTIYO], sec: { h: false, l: true, n: true } },
  { id: 3, key: 'supercapital', en: 'Standup Supercapital Shipyard I', zh: '屹立超级旗舰级船坞 I', activity: 'm',
    groups: [659, 30], categories: [], fitGroups: [], fitTypes: [SOTIYO], sec: { h: false, l: false, n: true } },
  { id: 4, key: 'reaction', en: 'Standup Composite Reactor I', zh: '屹立复合反应堆 I', activity: 'r',
    groups: [4764], categories: [], fitGroups: [1406], fitTypes: [], sec: secAll },
  { id: 5, key: null, en: 'Standup New Thing I', zh: '', activity: 'm',
    groups: [547], categories: [], fitGroups: [1404], fitTypes: [], sec: secAll },
]

function type(id: number, group: number): StructureTypeInfo {
  return { id, en: `S${id}`, zh: '', group, rigSize: 3, highsec: true, bonus: {} }
}
const raitaru = type(RAITARU, 1404)
const azbel = type(AZBEL, 1404)
const sotiyo = type(SOTIYO, 1404)
const athanor = type(ATHANOR, 1406)
const MAKE = ['manufacturing'] as const

const verdict = (product: { groupId: number; categoryId: number }, t: StructureTypeInfo | null, sec: 'high' | 'low' | 'null',
  opts: { npc?: boolean; supercap?: boolean; purposes?: Array<'manufacturing' | 'reaction' | 'reprocessing'> } = {}) =>
  capabilityVerdict(product, product === POLYMER ? 'reaction' : 'manufacturing',
    { type: t, npc: opts.npc ?? false, purposes: opts.purposes ?? [...MAKE], supercap: opts.supercap ?? false }, sec, services)

describe('servicesFor', () => {
  it('matches activity and group or category', () => {
    expect(servicesFor(CARRIER, 'manufacturing', services).map((s) => s.id)).toEqual([2, 5])
    expect(servicesFor({ groupId: 1, categoryId: 7 }, 'manufacturing', services).map((s) => s.id)).toEqual([1])
    expect(servicesFor(POLYMER, 'reaction', services).map((s) => s.id)).toEqual([4])
    expect(servicesFor(POLYMER, 'manufacturing', services)).toEqual([])
  })
})

describe('structureServices', () => {
  const ids = (t: StructureTypeInfo | null, npc: boolean, sec: 'high' | 'low' | 'null', supercap = false, purposes: Array<'manufacturing' | 'reaction' | 'reprocessing'> = ['manufacturing']) =>
    structureServices(t, npc, sec, supercap, purposes, services).map((s) => s.id)

  it('fit and security decide', () => {
    expect(ids(raitaru, false, 'high')).toEqual([1])
    expect(ids(azbel, false, 'high')).toEqual([1])
    expect(ids(azbel, false, 'null')).toEqual([1, 2])
    expect(ids(sotiyo, false, 'null')).toEqual([1, 2])
    expect(ids(sotiyo, false, 'null', true)).toEqual([1, 2, 3])
    expect(ids(sotiyo, false, 'low', true)).toEqual([1, 2])
  })
  it('purposes decide, unknown keys never count', () => {
    expect(ids(athanor, false, 'null', false, ['reaction'])).toEqual([4])
    expect(ids(athanor, false, 'null', false, ['manufacturing'])).toEqual([])
    expect(ids(raitaru, false, 'null', false, ['reaction'])).toEqual([])
  })
  it('NPC station and no structure only have manufacturing', () => {
    expect(ids(null, true, 'high')).toEqual([1])
    expect(ids(null, false, 'null')).toEqual([1])
  })
})

describe('capabilityVerdict', () => {
  it('supercarrier only on Sotiyo in nullsec with the switch', () => {
    expect(verdict(SUPERCARRIER, sotiyo, 'null', { supercap: true })).toEqual({ ok: true, known: true })
    expect(verdict(SUPERCARRIER, sotiyo, 'null')).toMatchObject({ ok: false, why: 'service' })
    expect(verdict(SUPERCARRIER, sotiyo, 'low', { supercap: true })).toMatchObject({ ok: false, why: 'sec' })
    expect(verdict(SUPERCARRIER, azbel, 'null', { supercap: true })).toMatchObject({ ok: false, why: 'service' })
  })
  it('carrier', () => {
    expect(verdict(CARRIER, azbel, 'null')).toEqual({ ok: true, known: true })
    expect(verdict(CARRIER, azbel, 'low')).toEqual({ ok: true, known: true })
    expect(verdict(CARRIER, azbel, 'high')).toMatchObject({ ok: false, why: 'sec' })
    expect(verdict(CARRIER, raitaru, 'null')).toMatchObject({ ok: false, why: 'service' })
    expect(verdict(CARRIER, null, 'null')).toMatchObject({ ok: false, why: 'service' })
  })
  it('carrier fails with need listing the covering services', () => {
    const v = verdict(CARRIER, raitaru, 'null')
    expect(v.ok === false && v.need.map((s) => s.id)).toEqual([2, 5])
  })
  it('freighter on Raitaru and NPC', () => {
    expect(verdict(FREIGHTER, raitaru, 'high')).toEqual({ ok: true, known: true })
    expect(verdict(FREIGHTER, null, 'high', { npc: true })).toEqual({ ok: true, known: true })
    expect(verdict(FREIGHTER, null, 'null')).toEqual({ ok: true, known: true })
  })
  it('reactions need a refinery with a reaction purpose', () => {
    expect(verdict(POLYMER, athanor, 'null', { purposes: ['reaction'] })).toEqual({ ok: true, known: true })
    expect(verdict(POLYMER, athanor, 'null')).toMatchObject({ ok: false, why: 'service' })
    expect(verdict(POLYMER, null, 'null', { npc: true })).toMatchObject({ ok: false, why: 'service' })
  })
  it('group 1194 is known:false and allowed; no services table is allowed too', () => {
    expect(verdict(ODD, raitaru, 'high')).toEqual({ ok: true, known: false })
    expect(capabilityVerdict(CARRIER, 'manufacturing', { type: raitaru, npc: false, purposes: MAKE, supercap: false }, 'high', null))
      .toEqual({ ok: true, known: false })
    expect(verdict(FRIGATE, raitaru, 'high')).toEqual({ ok: true, known: true })
  })
})

describe('needLabel', () => {
  it('strips the prefix and suffix', () => {
    expect(needLabel([services[1], services[2]])).toBe('旗舰级船坞 / 超级旗舰级船坞')
  })
  it('falls back to English', () => {
    expect(needLabel([{ ...services[1], zh: '' }])).toBe('Capital Shipyard')
  })
  it('keeps each name once', () => {
    expect(needLabel([services[1], services[1]])).toBe('旗舰级船坞')
  })
})
