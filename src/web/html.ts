// 管理页的 HTML 拼接：html`…` 里插进去的值一律转义，只有 raw() 包起来的才原样输出。
// 页面全部内联（样式、脚本），不引用任何外部资源。

export class Raw {
  constructor(readonly value: string) {}
  toString(): string {
    return this.value
  }
}

export const raw = (value: string) => new Raw(value)

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ESCAPES[c])
}

function render(value: unknown): string {
  if (value instanceof Raw) return value.value
  if (Array.isArray(value)) return value.map(render).join('')
  if (value === null || value === undefined || value === false) return ''
  return escapeHtml(String(value))
}

export function html(strings: TemplateStringsArray, ...values: unknown[]): Raw {
  let out = strings[0]
  for (let i = 0; i < values.length; i++) out += render(values[i]) + strings[i + 1]
  return new Raw(out)
}

/** 站内链接：参数按网址编码（插进 html`` 时再转义 &） */
export function href(path: string, params: Record<string, string | undefined> = {}): string {
  const query = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v !== undefined) query.set(k, v)
  const text = query.toString()
  return text ? `${path}?${text}` : path
}

const CSS = `
:root{color-scheme:light dark;--bg:#f6f7f9;--card:#fff;--text:#1d2329;--muted:#66707c;--line:#dde1e6;
--ok:#1f9d55;--warn:#c98a00;--bad:#d23c3c;--accent:#2f6fde;--code:#eef1f4}
@media (prefers-color-scheme:dark){:root{--bg:#14171c;--card:#1b1f26;--text:#d7dce3;--muted:#8a93a0;--line:#2a2f38;
--ok:#36c46b;--warn:#e0a526;--bad:#ef5350;--accent:#5b9bff;--code:#252b34}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.6 -apple-system,"PingFang SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans CJK SC",sans-serif}
main{max-width:960px;margin:0 auto;padding:24px 16px 48px}
h1{font-size:24px;margin:0 0 4px}h2{font-size:18px;margin:0 0 8px}
section{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px 18px;margin:16px 0}
p{margin:6px 0}.muted{color:var(--muted)}.small{font-size:13px}
code{background:var(--code);border-radius:4px;padding:1px 5px;font:13px/1.5 ui-monospace,Consolas,monospace;word-break:break-all}
table{width:100%;border-collapse:collapse;font-size:14px}th,td{text-align:left;padding:7px 8px;border-top:1px solid var(--line);vertical-align:top}
th{color:var(--muted);font-weight:600;border-top:none}
.dot{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:6px;vertical-align:1px}
.ok{color:var(--ok)}.warn{color:var(--warn)}.bad{color:var(--bad)}
.ok .dot,.dot.ok{background:var(--ok)}.warn .dot,.dot.warn{background:var(--warn)}.bad .dot,.dot.bad{background:var(--bad)}
.box{border-radius:8px;padding:10px 12px;margin:10px 0;border:1px solid var(--line)}
.box.bad{border-color:var(--bad);color:var(--bad)}.box.ok{border-color:var(--ok);color:var(--text)}.box.warn{border-color:var(--warn);color:var(--text)}
a{color:var(--accent)}
a.btn,button{display:inline-block;border:1px solid var(--accent);background:var(--accent);color:#fff;border-radius:6px;padding:4px 12px;
font:inherit;font-size:14px;text-decoration:none;cursor:pointer;margin:2px 4px 2px 0}
a.btn.plain,button.plain{background:transparent;color:var(--accent)}a.btn.danger{border-color:var(--bad);background:transparent;color:var(--bad)}
input,select{font:inherit;padding:4px 8px;border:1px solid var(--line);border-radius:6px;background:var(--card);color:var(--text);margin:2px 6px 2px 0}
.row{display:flex;flex-wrap:wrap;align-items:center;gap:4px}
ol{padding-left:22px;margin:6px 0}
`

// 「复制」按钮：data-copy 里是要复制的文字；剪贴板接口不可用（非本机的 http 地址）时退回 execCommand
const SCRIPT = `
document.addEventListener('click',function(e){
var b=e.target&&e.target.closest?e.target.closest('button[data-copy]'):null;if(!b)return;
var t=b.getAttribute('data-copy')||'';var done=function(){var o=b.textContent;b.textContent='已复制';setTimeout(function(){b.textContent=o},1500)};
var fallback=function(){var a=document.createElement('textarea');a.value=t;document.body.appendChild(a);a.select();
try{document.execCommand('copy');done()}catch(_){}document.body.removeChild(a)};
if(navigator.clipboard&&window.isSecureContext){navigator.clipboard.writeText(t).then(done,fallback)}else{fallback()}
});
`

export function copyButton(text: string): Raw {
  return html`<button type="button" class="plain" data-copy="${text}">复制</button>`
}

export function layout(title: string, body: Raw, nonce: string): string {
  return '<!doctype html>\n' + html`<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer">
<meta name="robots" content="noindex,nofollow"><title>${title} · EVE 市场助手</title><style>${raw(CSS)}</style></head>
<body><main>${body}</main><script nonce="${nonce}">${raw(SCRIPT)}</script></body></html>`.value
}
