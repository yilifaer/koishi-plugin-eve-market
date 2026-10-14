// KB 人物卡的全部文案（标题、导语、近况、页脚、照片说明、时区名）都在这一个文件里，所有者想改说法只改这里。
// 语气：毒舌，可以调侃战绩（「移动靶」「保险公司 VIP」这一类），但不攻击人，不写性别、地域、族群、现实身份，不说脏话，
// 不用性别代词（一律写名字）。tests/core/pilot/persona.test.ts 会扫一遍这里的词。
//
// 占位符：{name} 名字；{kills} 击毁；{losses} 损失；{solo} 单杀；{eff} 击毁价值占比（如 91%）；{isk} 击毁总价值（如 1.2T）；
// {k7} 近 7 天击毁；{ship} 最常驾驶的船；{system} 最常出没的星系；{region} 它所在的星域；{years} 建号几年（不满 1 年没有）。
// 模板里用到的数据缺了就跳过这一条，所以每个人设至少要有一条只用 {name} 的标题和一条只用 {name} 的导语。

import type { PersonaId, PilotZone } from '../types'

export interface PersonaCopy {
  /** 人设的名字，卡片的横幅上写 */
  label: string
  headlines: readonly string[]
  ledes: readonly string[]
}

export const PERSONA_COPY: Record<PersonaId, PersonaCopy> = {
  ghost: {
    label: '神秘人物',
    headlines: ['新伊甸查无此人战绩', '{name}：战绩一片空白', '{name}的击杀榜上目前只有灰尘'],
    ledes: [
      'zKillboard 翻遍了档案，没有找到{name}的任何击杀或损失。',
      '{name}至今没在 zKillboard 留下一条记录：要么爱好和平，要么还没开过火。',
      '没有击杀，没有损失，{name}的战绩页比空间站走廊还干净。',
    ],
  },
  rookie: {
    label: '初出茅庐',
    headlines: ['新星升起！{name}初入新伊甸', '{name}的战绩簿刚翻开第一页', '保护期刚过：{name}'],
    ledes: [
      '{name}目前{kills}次击毁、{losses}次损失，样本太小，吹不吹得起来要看下个月。',
      '战绩簿上才写了{kills}击毁、{losses}损失，保险公司已经记住了{name}的名字。',
      '{name}的新伊甸之路刚开了个头，吹牛的资本暂时没有，勇气倒是管够。',
    ],
  },
  capital: {
    label: '旗舰巨头',
    headlines: ['巨舰压境：{name}', '{name}一出场，星门都得让路', '{name}：吨位就是道理'],
    ledes: [
      '最常驾驶的{ship}，吨位说明一切。{kills}次击毁，{name}不用多说话。',
      '{name}的机库里停的不是船，是一座小城市：{kills}次击毁，{losses}次损失，每一次都够别人心疼一个月。',
      '一艘船的价钱抵别人整支舰队的预算，{name}靠它打出了{isk}的击毁价值。',
      '{name}出击要先看星门够不够大，{kills}次击毁，{losses}次损失。',
      '{name}一到场，星门都得重新量一遍尺寸。',
    ],
  },
  industrial: {
    label: '工业大亨',
    headlines: ['矿船比炮管更出名：{name}', '{name}：采矿激光比炮塔转得勤', '{name}和货舱相依为命'],
    ledes: [
      '{name}的损失榜上，货舰和矿船占了大半。{losses}次损失，保险公司 VIP 名单上永远留着座位。',
      '击毁{kills}次、损失{losses}次，亏的是运输船，赚的是故事。',
      '飞得最勤的是工业船，炸得最勤的也是它们：{name}给海盗们送了不少早餐。',
      '{name}撑起了半条补给线，也撑起了对手的击杀榜。',
    ],
  },
  wormhole: {
    label: '虫洞住民',
    headlines: ['虫洞常驻：{name}', '{name}：家在没有星门的地方', '{name}：信号一扫，邻居全到'],
    ledes: [
      '{kills}次击毁里，一半以上发生在虫洞里：{name}大概连星图上的住址都没有。',
      '虫洞里的邻居不多，{name}几乎都打过招呼了：{kills}次击毁。',
      '星图上找不到的地方，往往能找到{name}。',
    ],
  },
  ganker: {
    label: '高安猎手',
    headlines: ['星门口别站太久：{name}', '{name}：高安也不安全', '{name}：保险公司 VIP 的头号对手'],
    ledes: [
      '{kills}次击毁里，大头是在高安撞出来的。{name}和 CONCORD 想必是老相识。',
      '{name}教会了无数萌新一件事：星门口不要停。',
      '货舰最怕的名字之一。{kills}击毁，{losses}损失，「高安很安全」在{name}这里成了反面教材。',
    ],
  },
  solo: {
    label: '独狼猎手',
    headlines: ['独狼出没！{name}', '{name}：一个人，一艘船，一场架', '{name}：单打独斗，从不排队'],
    ledes: [
      '{kills}次击毁里有{solo}次是单杀。{name}更喜欢一对一，因为不用分战利品。',
      '别人开舰队，{name}开单刷。{solo}次单杀，说明了不少事。',
      '{system}是{name}最爱蹲的地方，单杀{solo}次，邻居们都知道。',
      '孤狼本色：{solo}次单杀，{name}从来不等人集合。',
      '{name}的飞行风格：不等人，不拉人，不分战利品。',
    ],
  },
  fleet: {
    label: '舰队老兵',
    headlines: ['舰队中流砥柱：{name}', '{name}：集合令一响，人就到', '{name}：个人英雄主义？不存在的'],
    ledes: [
      '抱团度高得惊人，{name}的每条战绩背后都站着一整支舰队。',
      '{kills}次击毁，大多是在队伍里拿下的：{name}擅长在人堆里找准位置。',
      '{name}参加的战斗，参与者名单通常比战报还长。',
      '建号{years}年，{name}一直是舰队名单里最靠谱的那个名字。',
    ],
  },
  reaper: {
    label: '战场死神',
    headlines: ['死神在此：{name}', '{name}：被盯上的人通常没有第二次机会', '{name}：危险度拉满'],
    ledes: [
      '危险度高得吓人，{kills}次击毁。{name}的名字一出现在本地，对面就开始思考人生。',
      '{name}出手极少落空：{kills}击毁，{losses}损失，击毁价值占比{eff}。',
      '对手的保险公司对{name}这个名字印象深刻。',
    ],
  },
  underdog: {
    label: '越挫越勇',
    headlines: ['越挫越勇：{name}', '{name}：击毁数还没损失数多', '{name}：移动靶，但不服输'],
    ledes: [
      '损失{losses}次、击毁{kills}次。{name}是保险公司的 VIP，也是最执着的那一位。',
      '每次被击毁都说「再来一艘」，{name}已经来了{losses}次。',
      '{name}的飞船消耗速度，大概是这一带最稳定的 ISK 流向。',
    ],
  },
  pilot: {
    label: '新伊甸战士',
    headlines: ['又一位新伊甸战士：{name}', '{name}：不好不坏，稳稳地活着', '{name}的战绩：认真飞，认真炸'],
    ledes: [
      '{name}{kills}次击毁、{losses}次损失，数字不吓人，也不丢人。',
      '一路打到现在，{kills}击毁对{losses}损失，保险公司对{name}只有礼貌的好感。',
      '{ship}是{name}的老伙计，{kills}次击毁里它出了大力。',
      '常在{region}一带出没，近一周击毁{k7}艘：{name}的日子过得挺忙。',
      '{name}不算最亮的星，但也一直没从星图上掉下去。',
    ],
  },
  unknown: {
    label: '战绩暂缺',
    headlines: ['{name}：战绩暂缺', '{name}的档案还在路上', '{name}：zKillboard 暂时没回话'],
    ledes: [
      '战绩服务器这会儿没回话，先看看{name}的基本信息吧。',
      '{name}的击杀记录暂时调不出来，稍后再查。',
      '档案室的门暂时关着，{name}的战绩晚点补上。',
    ],
  },
}

/** 近况一句 */
export const MOOD_TEXT = {
  hotWeek: '本周火力全开',
  dormant: (months: number) => `已潜水 ${months} 个月`,
  dormantLong: '已潜水一年以上',
  bigKill: '近日猎获 {isk}',
  bigLoss: '近日送出 {isk}，保险公司表示感谢',
} as const

/** 页脚：数据来源和免责声明 */
export const FOOTER_TEXT = '数据：zKillboard / 欧服官方接口 · 本报纯属娱乐'

/** 照片说明 */
export const BIRTHPLACE_TEXT = {
  at: (station: string) => `摄于 ${station}`,
  fallback: '摄于新伊甸某处',
} as const

/** 作息一行 */
export const ACTIVITY_TEXT = {
  /** 北京时间在前，EVE 时间（UTC）在括号里：北京 20:00–23:00（EVE 12–15） */
  peak: (beijingStart: string, beijingEnd: string, utcStart: number, utcEnd: number) =>
    `北京 ${beijingStart}–${beijingEnd}（EVE ${utcStart}–${utcEnd}）`,
  zones: (names: string[]) => `主要时区：${names.join(' / ')}`,
} as const

export const ZONE_NAMES: Record<PilotZone, string> = {
  eu: '欧洲',
  ru: '俄服',
  use: '美东',
  usw: '美西',
  au: '澳洲',
}
