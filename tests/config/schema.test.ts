import { describe, expect, it } from 'vitest'
import { Config } from '../../src/config/schema'
import { formatIssue, INVALID_ROW_KEY, normalizeConfig } from '../../src/config/normalize'
import { PRESET_MARKETS } from '../../src/config/presets'

/** Schema.intersect 里第 i 组的第一个字段 */
function group(i: number) {
  const g = (Config as any).list[i]
  const key = Object.keys(g.dict)[0]
  return { key, schema: g.dict[key], description: g.meta.description }
}

function tableOf(schema: any) {
  expect(schema.type).toBe('array')
  expect(schema.meta.role).toBe('table')
  expect(schema.inner.type).toBe('object')
  return Object.keys(schema.inner.dict)
}

describe('Config schema', () => {
  it('fills every group from an empty config', () => {
    const c = Config({} as any)
    expect(Object.keys(c)).toEqual(['general', 'display', 'access', 'markets', 'aliases', 'price', 'appraisal', 'freight', 'notices', 'industry', 'sso', 'render', 'screenshot', 'janice', 'kb', 'advanced'])
    expect(c.general).toEqual({ requireAt: true, allowSandbox: false, qqWatchdog: true })
    expect(c.display).toMatchObject({ output: 'markdown', numberStyle: 'code', priceDisplayMode: 'full_and_compact', listPriceDisplayMode: 'compact_only', compactDecimals: 2, clickable: 'buttons' })
    expect(c.markets.map((m) => m.name)).toEqual(['Jita 4-4', 'Amarr', 'Dodixie', 'Rens', 'Hek'])
    expect(c.price).toEqual({ baseMarket: 'Jita 4-4', defaultQuantities: [{ item: 'PLEX', quantity: 500 }] })
    expect(c.appraisal).toEqual({ defaultMarket: 'Jita 4-4', defaultPriceType: 'sell', fallbackMarket: '' })
    expect(c.sso.callbackUrl).toBe('http://127.0.0.1:5140/eve-market/sso/callback')
    expect(c.advanced.manifestUrl).toContain('yilifaer/eve-cn-slang')
    expect(normalizeConfig(c).issues).toEqual([])
  })

  it('the screenshot group has the killAuto switch (default on, described in Chinese)', () => {
    expect(Config({} as any).screenshot.killAuto).toBe(true)
    const shot = (Config as any).list[12].dict.screenshot
    expect(Object.keys(shot.dict)[0]).toBe('killAuto')
    expect(shot.dict.killAuto.meta.description).toContain('zKill 击杀链接')
  })

  it('the Janice group: a secret key field (blank = off) and who defaults to allowed', () => {
    expect(Config({} as any).janice).toEqual({ apiKey: '', who: 'allowed' })
    const janice = (Config as any).list[13].dict.janice
    expect(janice.dict.apiKey.meta.role).toBe('secret')
    expect(janice.dict.apiKey.meta.description).toContain('请求头')
    expect(Config({ janice: { who: 'bogus' } } as any).janice.who).toBe('allowed')
  })

  it('the KB group: everyone, recent and auto on, an empty hidden table of id / note / enabled', () => {
    expect(Config({} as any).kb).toEqual({ scope: 'all', recent: true, auto: true, tone: 'mixed', hidden: [] })
    expect(Config({ kb: { scope: 'bogus' } } as any).kb.scope).toBe('all')
    const kb = (Config as any).list[14].dict.kb
    expect(Object.keys(kb.dict)).toEqual(['scope', 'recent', 'auto', 'tone', 'hidden'])
    expect(tableOf(kb.dict.hidden)).toEqual(['characterId', 'note', 'enabled'])
    expect(kb.dict.auto.meta.description).toContain('zKill 人物链接')
    expect(Config({ kb: { tone: 'bogus' } } as any).kb.tone).toBe('mixed')
    expect(Config({ kb: { tone: 'snarky' } } as any).kb.tone).toBe('snarky')
    expect(kb.dict.tone.meta.description).toContain('毒舌程度')
  })

  it('has the groups in console order with Chinese titles; industry since 0.2.0', () => {
    const titles = (Config as any).list.map((g: any) => g.meta.description)
    expect(titles).toEqual(['基本', '显示', '权限', '市场', '物品别名', '查价', '批量查价', '运费', '查价告示', '工业', 'EVE 授权', '图片与截图', '截图', 'Janice 估价', 'KB 人物卡', '高级'])
    expect(group(9).key).toBe('industry')
    expect(group(15).schema.meta.collapse).toBe(true)
  })

  it('keeps every table an object schema so the console table works', () => {
    expect(tableOf(group(3).schema)).toEqual(['name', 'aliases', 'type', 'location', 'system', 'enabled', 'inDefaultList', 'sortOrder', 'visibility', 'authProfile', 'note'])
    expect(tableOf(group(4).schema)).toEqual(['alias', 'target', 'enabled', 'note'])
    const access = group(2).schema.dict
    expect(tableOf(access.allowedGroups)).toEqual(['groupId', 'note', 'enabled'])
    expect(tableOf(access.allowedUsers)).toEqual(['userId', 'note', 'enabled'])
    expect(tableOf(group(5).schema.dict.defaultQuantities)).toEqual(['item', 'quantity'])
    expect(tableOf(group(7).schema.dict.routes)).toEqual(['name', 'iskPerM3', 'collateralPct', 'maxVolume', 'visibility', 'enabled', 'note'])
    expect(tableOf(group(8).schema.dict.list)).toEqual(['text', 'visibility', 'until', 'enabled'])
  })

  it('marks secrets', () => {
    const sso = group(10).schema.dict
    expect(sso.clientSecret.meta.role).toBe('secret')
    expect(sso.adminKey.meta.role).toBe('secret')
    expect(sso.clientId.meta.role).toBeUndefined()
  })

  it('never throws on wrongly typed values', () => {
    // 插件配置本身总是对象（或者没写）；里面的每个字段都可能写错
    const garbage: any[] = [
      undefined, null,
      { general: 5, display: 'x', access: [], markets: 'oops', aliases: 3, price: null, appraisal: true, freight: 'x', notices: 1, sso: [], render: 0, advanced: 'x' },
      { display: { compactDecimals: 'many', output: 'html', clickable: 1 }, access: { admins: 'qq:1', allowedGroups: 'x' } },
      { markets: [1, 'x', null, [], { name: 7 }], price: { defaultQuantities: [{ item: 1, quantity: 'x' }] } },
    ]
    for (const raw of garbage) {
      const c = Config(raw)
      expect(() => normalizeConfig(c)).not.toThrow()
      expect(() => normalizeConfig(raw)).not.toThrow()
    }
  })

  it('a bad row only invalidates itself', () => {
    const good = { name: '测试站', type: 'npc-station', location: '60000004' }
    const cases: any[] = [
      'oops',
      ['x'],
      { ...good, name: '坏行', type: 'station' },
      { ...good, name: '坏行', enabled: 'yes' },
      { ...good, name: '坏行', inDefaultList: 'maybe' },
      { ...good, name: '坏行', visibility: 'everyone' },
    ]
    for (const bad of cases) {
      const c = Config({ markets: [good, bad] } as any)
      expect(c.markets).toHaveLength(2)
      expect((c.markets[1] as any)[INVALID_ROW_KEY]).toBe(true)
      const { settings, issues } = normalizeConfig(c)
      expect(settings.markets.map((m) => m.name)).toEqual(['测试站'])
      expect(issues.map(formatIssue)).toContain('市场第 2 行有写错的字段（例如类型、启用写成了别的值），已跳过')
    }
  })

  it('loose scalar fields fall back to their defaults inside a row', () => {
    const c = Config({ markets: [{ name: '测试站', location: 60000004, sortOrder: 'x' }] } as any)
    expect(c.markets[0]).toMatchObject({ name: '测试站', type: 'npc-station', location: '', sortOrder: 0, enabled: true })
  })

  it('presets only contain the five public trade hubs', () => {
    expect(PRESET_MARKETS.map((m) => [m.name, m.location])).toEqual([
      ['Jita 4-4', '60003760'], ['Amarr', '60008494'], ['Dodixie', '60011866'], ['Rens', '60004588'], ['Hek', '60005686'],
    ])
    expect(PRESET_MARKETS.every((m) => m.type === 'npc-station' && m.visibility === 'auto')).toBe(true)
  })
})
