import { describe, expect, it } from 'vitest'
import { CATEGORY_SHIP, classifyMaterial, GROUP_FUEL_BLOCK, GROUP_TOOL } from '../../../../src/core/industry/chain/layers'
import type { BlueprintActivity, ItemInfo } from '../../../../src/core/types'
import { loadSnapshotData } from '../../../fixtures/data/load'

function item(typeId: number, over: Partial<ItemInfo> = {}): ItemInfo {
  return { typeId, en: `T${typeId}`, zh: '', groupId: 1, categoryId: 43, marketGroupId: null, metaGroupId: null, techLevel: 1,
    volume: 1, packagedVolume: 1, portionSize: 1, capacity: null, variationParent: null, ...over }
}
const recipe = (typeId: number, inputs: number[]): BlueprintActivity => ({
  blueprintId: typeId + 1000, activity: 'r', time: 1, maxRuns: 1,
  products: [{ typeId, quantity: 1 }], materials: inputs.map((id) => ({ typeId: id, quantity: 1 })),
})

const industry = {
  reactions: new Map([[10, recipe(10, [1, 2])], [11, recipe(11, [10, 2])]]),
  manufacturing: new Map([[20, recipe(20, [10])], [21, recipe(21, [10])], [22, recipe(22, [10])], [23, recipe(23, [10])],
    [24, recipe(24, [10])], [30, recipe(30, [20])]]),
}

describe('classifyMaterial', () => {
  it('reactions: a reaction product as input means reaction2', () => {
    expect(classifyMaterial(item(10), null, industry)).toBe('reaction1')
    expect(classifyMaterial(item(11), null, industry)).toBe('reaction2')
  })
  it('no blueprint means raw', () => {
    expect(classifyMaterial(item(1), null, industry)).toBe('raw')
  })
  it('components', () => {
    expect(classifyMaterial(item(20), null, industry)).toBe('component')
  })
  it('ships, fuel blocks and tools are other', () => {
    expect(classifyMaterial(item(21, { categoryId: CATEGORY_SHIP }), null, industry)).toBe('other')
    expect(classifyMaterial(item(22, { groupId: GROUP_FUEL_BLOCK }), null, industry)).toBe('other')
    expect(classifyMaterial(item(23, { groupId: GROUP_TOOL }), null, industry)).toBe('other')
  })
  it('the T1 parent of a T2 product is other, but only for that product', () => {
    const t2 = item(30, { techLevel: 2, variationParent: 24 })
    expect(classifyMaterial(item(24), t2, industry)).toBe('other')
    expect(classifyMaterial(item(24), item(31, { techLevel: 2, variationParent: 99 }), industry)).toBe('component')
    expect(classifyMaterial(item(24), item(30, { techLevel: 1, variationParent: 24 }), industry)).toBe('component')
    expect(classifyMaterial(item(24), null, industry)).toBe('component')
  })
})

describe('constants match the data', () => {
  const data = loadSnapshotData()
  it('ids', () => {
    expect(data.categories.get(CATEGORY_SHIP)?.en).toBe('Ship')
    expect(data.groups.get(GROUP_FUEL_BLOCK)?.en).toBe('Fuel Block')
    expect(data.groups.get(GROUP_TOOL)?.en).toBe('Tool')
  })
  it('real items', () => {
    const name = (en: string) => data.types.item(data.types.rowOf([...Array(data.types.en.length).keys()].map((i) => data.types.item(i)).find((it) => it.en === en)!.typeId))
    expect(classifyMaterial(name('Hydrogen Fuel Block'), null, data.industry)).toBe('other')
    expect(classifyMaterial(name('Tritanium'), null, data.industry)).toBe('raw')
    expect(classifyMaterial(name('Raven'), null, data.industry)).toBe('other')
  })
})
