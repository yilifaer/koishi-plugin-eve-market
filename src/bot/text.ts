// bot 层接线部分（端口、范围、前置中间件、注册）用到的中文文字：群里看到的提示、「市场状态」里的说明、日志。

/** 发到群里或私聊里的提示 */
export const REPLY = {
  /** 「取消」清掉了这个人的待办 */
  cancelled: '已取消。',
  /** 只发了编号，但没有待办或已经过期 */
  choiceExpired: '这个编号已经过期了，请重新查询',
  /** 有待办，但编号不在列表里 */
  choiceMissing: (no: number, max: number) => max > 1
    ? `没有第 ${no} 项，请回复 1–${max} 之间的编号`
    : `没有第 ${no} 项，请回复 1`,
} as const

/** 「市场状态」的「命令冲突」一行 */
export const CONFLICT = {
  name: (name: string) => `「${name}」和别的插件的命令重名，没有注册`,
  alias: (alias: string, name: string) => `「${name}」的别名「${alias}」和别的插件重名，只跳过这个别名`,
  error: (name: string) => `「${name}」注册时出错，没有注册`,
  none: '无',
} as const

/** 写进日志的文字（不含令牌、消息内容） */
export const LOG = {
  conflict: (detail: string) => `命令冲突：${detail}`,
  registerError: (name: string, reason: string) => `注册命令「${name}」时出错：${reason}`,
  secretKeyUnreadable: (reason: string) => `读取 EVE 授权的密钥文件失败，授权功能暂时不能用：${reason}`,
  secretKeyCreated: '已生成 EVE 授权用的密钥文件 secret.key（迁移机器时要和数据库一起备份）',
} as const

/** 网络错误的说明（进日志和「市场状态」） */
export const NET = {
  timeout: (ms: number) => `${ms} 毫秒没有响应`,
  tooLarge: (max: number) => `响应超过 ${max} 字节`,
  aborted: '请求已取消',
  failed: (reason: string) => `连接失败：${reason}`,
} as const

/** 密钥和缓存的错误说明 */
export const STORE = {
  badCacheKey: (key: string) => `缓存键不合法：${key}`,
  badSecretKey: 'secret.key 不是 32 字节的密钥',
  secretUnavailable: '密钥文件不可用',
  sealedMalformed: '密文格式不对',
  sealedOtherKey: '密文是用另一个密钥加密的',
  sealedTampered: '密文校验失败',
} as const
