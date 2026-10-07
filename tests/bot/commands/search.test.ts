// 搜索的参数：末尾的「第N页」「涂装」先去掉，它们不是市场，也不该参与切市场。

import { describe, expect, it } from 'vitest'
import { parseSearch } from '../../../src/bot/commands/search'

describe('parseSearch', () => {
  it('reads the page and the skin word at the end', () => {
    expect(parseSearch('乌鸦')).toEqual({ keyword: '乌鸦', page: 1, skins: false })
    expect(parseSearch('乌鸦 第2页')).toEqual({ keyword: '乌鸦', page: 2, skins: false })
    expect(parseSearch('乌鸦第 3 页')).toEqual({ keyword: '乌鸦', page: 3, skins: false })
    expect(parseSearch('Jita 乌鸦级 涂装 第2页')).toEqual({ keyword: 'Jita 乌鸦级', page: 2, skins: true })
    expect(parseSearch('raven  skin')).toEqual({ keyword: 'raven', page: 1, skins: true })
    expect(parseSearch('第0页')).toEqual({ keyword: '', page: 1, skins: false })
  })

  it('a skin word inside the name is kept', () => {
    expect(parseSearch('涂装')).toEqual({ keyword: '涂装', page: 1, skins: false })
    expect(parseSearch('Raven Wiyrkomi SKIN')).toEqual({ keyword: 'Raven Wiyrkomi', page: 1, skins: true })
  })
})
