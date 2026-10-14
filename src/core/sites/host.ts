// 域名检查：配置里的域名是否合法、一个主机是不是内网 / 本机地址。纯函数。

/** 配置里不允许的内网后缀 */
const LOCAL_SUFFIXES = ['.local', '.internal', '.lan', '.home.arpa', '.localdomain', '.localhost']
const BLOCKED_DOMAINS = ['zkillboard.com']
/** 公共 DNS 服务：任何名字都能解析到任意地址（含 127.0.0.1），等同内网 */
const WILDCARD_DNS_DOMAINS = [
  'nip.io', 'sslip.io', 'xip.io', 'traefik.me', 'localtest.me', 'lvh.me', 'vcap.me',
  'lacolhost.com', '1u.ms', 'rbndr.us', 'rebind.it', 'rebind.network',
]
/** 公共托管域名：任何人都能在下面开网站，只能填具体的子域名 */
const SHARED_HOSTING_SUFFIXES = [
  'github.io', 'gitlab.io', 'pages.dev', 'workers.dev', 'vercel.app', 'netlify.app', 'herokuapp.com',
  'web.app', 'firebaseapp.com', 'appspot.com', 'blogspot.com', 'cloudfront.net', 'azurewebsites.net',
  'glitch.me', 'onrender.com', 'fly.dev', 'surge.sh', 'ngrok.io', 'ngrok-free.app', 'trycloudflare.com',
]

const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?'
const DOMAIN = new RegExp(`^(?:${LABEL}\\.)+${LABEL}$`)

export type ConfigHostCheck =
  | { ok: true; host: string; note?: string }
  | { ok: false; reason: string }

/** 主机等于域名，或是它的子域名（都已转小写） */
export function hostMatches(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`)
}

function ipv4Octets(host: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (!m) return null
  const parts = m.slice(1).map(Number)
  return parts.every((n) => n <= 255) ? parts : null
}

/** 解析 IPv6（含末尾的点分 IPv4）为 8 个 16 位；不合法返回 null */
function ipv6Groups(input: string): number[] | null {
  let text = input.toLowerCase()
  const tail = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text)
  if (tail) {
    const v4 = ipv4Octets(tail[1])
    if (!v4) return null
    text = `${text.slice(0, tail.index)}${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`
  }
  if (!/^[0-9a-f:]+$/.test(text)) return null
  const halves = text.split('::')
  if (halves.length > 2) return null
  const parse = (part: string): number[] | null => {
    if (part === '') return []
    const groups = part.split(':')
    if (groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null
    return groups.map((g) => parseInt(g, 16))
  }
  const head = parse(halves[0])
  const rest = halves.length === 2 ? parse(halves[1]) : []
  if (!head || !rest) return null
  if (halves.length === 1) return head.length === 8 ? head : null
  const fill = 8 - head.length - rest.length
  if (fill < 1) return null
  return [...head, ...new Array<number>(fill).fill(0), ...rest]
}

function privateV4(o: number[]): boolean {
  const [a, b] = o
  return a === 0 || a === 10 || a === 127
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 100 && b >= 64 && b <= 127)
}

function privateV6(g: number[]): boolean {
  const zero5 = g.slice(0, 5).every((x) => x === 0)
  if (zero5 && g[5] === 0 && g[6] === 0 && g[7] <= 1) return true // :: 和 ::1
  if (zero5 && (g[5] === 0xffff || g[5] === 0)) return privateV4([g[6] >> 8, g[6] & 255, g[7] >> 8, g[7] & 255]) // IPv4 映射 / 兼容
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return privateV4([g[6] >> 8, g[6] & 255, g[7] >> 8, g[7] & 255]) // NAT64
  if ((g[0] & 0xfe00) === 0xfc00) return true // fc00::/7
  if ((g[0] & 0xffc0) === 0xfe80) return true // fe80::/10
  return false
}

/**
 * 主机是不是本机 / 内网地址：localhost、单段名字、.local 这类后缀、内网段的 IP 字面量。
 * 不拦 198.18.0.0/15（代理软件的 fake-ip 网段，拦了会让所有网站都打不开）。
 * 拿不准（空、写法怪）时按内网处理。
 */
export function isPrivateNetworkHost(input: string): boolean {
  let host = input.trim().toLowerCase()
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1)
  if (host.endsWith('.')) host = host.slice(0, -1)
  if (!host) return true
  if (host.includes(':')) {
    const groups = ipv6Groups(host)
    return groups ? privateV6(groups) : true
  }
  // 用 URL 还原 2130706433、0x7f.1 这类写法
  let canonical: string
  try {
    canonical = new URL(`http://${host}`).hostname
  } catch {
    return true
  }
  if (canonical.startsWith('[')) return isPrivateNetworkHost(canonical)
  const octets = ipv4Octets(canonical)
  if (octets) return privateV4(octets)
  if (!canonical.includes('.')) return true
  if (WILDCARD_DNS_DOMAINS.some((d) => hostMatches(canonical, d))) return true
  return LOCAL_SUFFIXES.some((s) => canonical.endsWith(s) || canonical === s.slice(1))
}

/** 控制台里填的域名是否合法；合法时给出整理后的小写域名 */
export function checkConfigHost(input: string): ConfigHostCheck {
  let raw = input.trim()
  if (!raw) return { ok: false, reason: '域名是空的' }
  let note: string | undefined
  const scheme = /^[a-z][a-z0-9+.-]*:\/\//i.exec(raw)
  if (scheme) raw = raw.slice(scheme[0].length)
  const cut = raw.search(/[/?#]/)
  if (cut >= 0) raw = raw.slice(0, cut)
  if (scheme || cut >= 0) note = '已只取域名'
  if (!raw) return { ok: false, reason: '域名是空的' }
  if (raw.includes('@')) return { ok: false, reason: '域名里不能带用户名' }
  if (raw.startsWith('[')) return { ok: false, reason: '不能填 IP 地址' }
  if (raw.includes(':')) return { ok: false, reason: '域名里不能带端口' }
  if (raw.endsWith('.')) return { ok: false, reason: '域名结尾不能有点' }
  if (/\s/.test(raw)) return { ok: false, reason: '域名里不能有空格' }
  let host: string
  try {
    host = new URL(`http://${raw}`).hostname
  } catch {
    return { ok: false, reason: '域名写法不对' }
  }
  if (host.startsWith('[') || ipv4Octets(host)) return { ok: false, reason: '不能填 IP 地址' }
  if (host === 'localhost' || host.endsWith('.localhost')) return { ok: false, reason: '不能填本机地址' }
  if (!host.includes('.')) return { ok: false, reason: '域名要带点，不能是单段名字' }
  if (LOCAL_SUFFIXES.some((s) => host.endsWith(s) || host === s.slice(1))) return { ok: false, reason: '不能填内网域名' }
  if (WILDCARD_DNS_DOMAINS.some((d) => hostMatches(host, d))) return { ok: false, reason: '这个域名可以解析到任意地址（包括内网），不能用' }
  if (SHARED_HOSTING_SUFFIXES.includes(host)) return { ok: false, reason: '这是公共托管域名，任何人都能在下面开网站，请填具体的子域名（例如 xxx.github.io）' }
  if (BLOCKED_DOMAINS.some((d) => hostMatches(host, d))) return { ok: false, reason: '暂不支持 zKillboard，以后会另做' }
  if (host.length > 253 || !DOMAIN.test(host)) return { ok: false, reason: '域名写法不对' }
  return note ? { ok: true, host, note } : { ok: true, host }
}
