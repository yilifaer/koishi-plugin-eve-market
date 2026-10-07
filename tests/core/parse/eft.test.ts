import { describe, expect, it } from 'vitest'
import { eftHeader, eftItem, isBracketLine, isMutationBlockStart } from '../../../src/core/parse/eft'

describe('EFT lines', () => {
  it('reads the header: ship and fitting name (which may contain commas)', () => {
    expect(eftHeader('[Raven, 刷怪乌鸦]')).toEqual({ ship: 'Raven', name: '刷怪乌鸦' })
    expect(eftHeader('[Raven, PvE, 第二版]')).toEqual({ ship: 'Raven', name: 'PvE, 第二版' })
    expect(eftHeader('[Raven,]')).toEqual({ ship: 'Raven', name: '' })
    expect(eftHeader('[Empty High slot]')).toBeUndefined()
    expect(eftHeader('Raven, Scourge Cruise Missile')).toBeUndefined()
  })

  it('tells bracket lines and mutation blocks apart', () => {
    expect(isBracketLine('[Empty Low slot]')).toBe(true)
    expect(isBracketLine('[空高槽位]')).toBe(true)
    expect(isMutationBlockStart('[1] Damage Control II')).toBe(true)
    expect(isMutationBlockStart('[Empty Low slot]')).toBe(false)
  })

  it('strips the offline marker', () => {
    expect(eftItem('Drone Damage Amplifier II /OFFLINE')).toEqual({ role: 'module', name: 'Drone Damage Amplifier II', mutated: false })
    expect(eftItem('Drone Damage Amplifier II /offline')).toEqual({ role: 'module', name: 'Drone Damage Amplifier II', mutated: false })
    expect(eftItem('无人机伤害增效装置 II /离线')).toEqual({ role: 'module', name: '无人机伤害增效装置 II', mutated: false })
  })

  it('splits a loaded charge from its module', () => {
    expect(eftItem('Cruise Missile Launcher II, Scourge Cruise Missile')).toEqual({
      role: 'module', name: 'Cruise Missile Launcher II', loadedCharge: 'Scourge Cruise Missile', mutated: false,
    })
    expect(eftItem('Cruise Missile Launcher II, Scourge Cruise Missile /OFFLINE')).toMatchObject({ loadedCharge: 'Scourge Cruise Missile' })
    expect(eftItem('Cruise Missile Launcher II,')).toEqual({ role: 'module', name: 'Cruise Missile Launcher II', mutated: false })
  })

  it('reads drones and cargo as name xN', () => {
    expect(eftItem('Hobgoblin II x5')).toEqual({ role: 'cargo', name: 'Hobgoblin II', quantity: 5, mutated: false })
    expect(eftItem('Exotic Dancers, Male x10')).toEqual({ role: 'cargo', name: 'Exotic Dancers, Male', quantity: 10, mutated: false })
    expect(eftItem('Hobgoblin II x0')).toEqual({ role: 'bad-quantity' })
    expect(eftItem('X-Large Ancillary Shield Booster')).toEqual({ role: 'module', name: 'X-Large Ancillary Shield Booster', mutated: false })
  })

  it('marks mutated modules and keeps the base type', () => {
    expect(eftItem('Damage Control II [1]')).toEqual({ role: 'module', name: 'Damage Control II', mutated: true })
    expect(eftItem('Damage Control II [12] /OFFLINE')).toEqual({ role: 'module', name: 'Damage Control II', mutated: true })
  })
})
