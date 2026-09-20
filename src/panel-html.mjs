import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 狼群实时面板 — 服务端渲染的 HTML 外壳（零依赖、无构建）。
 *
 * 浏览器端脚本是真实文件 src/panel-client.js，这里读进来内联一次：
 * 于是「一个 HTML 请求」就够，不需要额外的静态资源路由，也不依赖任何打包器。
 * 面板只读 /wolfpack/live，**两个工人分开展示**。
 */

const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * 读取浏览器端脚本源码（读不到时退化为空脚本，页面其余部分仍可用）。
 *
 * @returns {string}
 */
function readClientSource() {
  try {
    return readFileSync(join(HERE, 'panel-client.js'), 'utf8')
  } catch {
    return '/* panel-client.js 读取失败 */'
  }
}

/** 浏览器端脚本（内联用，模块加载时读一次）。 */
export const PANEL_CLIENT_SOURCE = readClientSource()

/** 面板样式（自适应深浅色）。 */
const PANEL_CSS = `
:root{color-scheme:light dark;}
*{box-sizing:border-box;}
body{margin:0;padding:16px 18px 40px;font:13px/1.55 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue','PingFang SC','Microsoft YaHei',sans-serif;background:light-dark(#f7f7f8,#15161a);color:light-dark(#1b1c20,#e8e9ee);}
.top{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;padding-bottom:10px;border-bottom:1px solid light-dark(rgba(0,0,0,.1),rgba(255,255,255,.12));}
.top h1{font-size:15px;margin:0;display:flex;align-items:center;gap:8px;}
.top .meta{font-size:11px;opacity:.62;display:flex;align-items:center;gap:10px;flex-wrap:wrap;}
.btn{font-size:11px;padding:2px 8px;border-radius:6px;border:1px solid light-dark(rgba(0,0,0,.18),rgba(255,255,255,.2));background:light-dark(rgba(0,0,0,.04),rgba(255,255,255,.06));color:inherit;cursor:pointer;}
.btn:hover{background:light-dark(rgba(0,0,0,.09),rgba(255,255,255,.13));}
.btn.on{background:#2f9e63;border-color:#2f9e63;color:#fff;}
#error{display:none;margin:10px 0;padding:8px 10px;border-radius:6px;font-size:12px;background:rgba(224,112,112,.14);border:1px solid rgba(224,112,112,.35);color:#c85656;}
#workers{display:grid;grid-template-columns:repeat(auto-fit,minmax(420px,1fr));gap:16px;margin-top:14px;align-items:start;}
.worker{border:1px solid light-dark(rgba(0,0,0,.1),rgba(255,255,255,.12));border-radius:10px;padding:12px;background:light-dark(#fff,rgba(255,255,255,.03));}
.worker-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px;}
.worker-title{display:flex;align-items:baseline;gap:8px;font-weight:650;font-size:13.5px;}
.worker-stats{display:flex;flex-wrap:wrap;gap:6px 10px;font-size:11px;opacity:.85;padding-bottom:8px;border-bottom:1px dashed light-dark(rgba(0,0,0,.12),rgba(255,255,255,.14));}
.stat.mono{font-size:10.5px;}
.store{max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;opacity:.55;}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;}
.muted{opacity:.65;}
.tag{display:inline-block;padding:1px 6px;border-radius:4px;font-size:10px;font-weight:600;background:light-dark(rgba(0,0,0,.06),rgba(255,255,255,.09));}
.tag.running{color:#2f9e63;background:rgba(47,158,99,.16);}
.tag.idle{opacity:.6;}
.tag.v-pass{color:#2f9e63;background:rgba(47,158,99,.16);}
.tag.v-fail,.tag.v-error{color:#c85656;background:rgba(224,112,112,.16);}
.tag.v-stale{color:#b8860b;background:rgba(224,160,48,.16);}
.tag.v-unverified,.tag.v-none{opacity:.7;}
.tag.r-auto{color:#3b7ddd;background:rgba(59,125,221,.14);}
.tag.r-fallback{color:#b8860b;background:rgba(224,160,48,.18);}
.tag.r-bench{color:#c85656;background:rgba(224,112,112,.16);}
.stall{margin:8px 0;padding:6px 9px;border-radius:6px;font-size:11.5px;line-height:1.5;border:1px solid transparent;background:light-dark(rgba(0,0,0,.04),rgba(255,255,255,.05));}
.stall.ok{border-color:rgba(47,158,99,.3);}
.stall.idle{opacity:.7;}
.stall.off{opacity:.7;}
.stall.unknown{opacity:.8;}
.stall.warn{border-color:rgba(224,160,48,.45);background:rgba(224,160,48,.13);color:#a8781f;}
.runs{display:flex;flex-direction:column;gap:8px;margin-top:8px;}
.run{border-radius:8px;padding:9px 10px;background:light-dark(rgba(0,0,0,.025),rgba(255,255,255,.04));border:1px solid light-dark(rgba(0,0,0,.08),rgba(255,255,255,.09));}
.run.is-running{border-color:rgba(47,158,99,.35);}
.run.is-idle{opacity:.92;}
.run-head{display:flex;align-items:center;gap:7px;flex-wrap:wrap;font-size:11.5px;}
.task-id{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-weight:650;}
.dot{width:8px;height:8px;border-radius:50%;flex:none;background:#999;opacity:.5;}
.dot.running{background:#2f9e63;opacity:1;animation:wp-pulse 1.5s infinite;}
@keyframes wp-pulse{0%{box-shadow:0 0 0 0 rgba(47,158,99,.6);}70%{box-shadow:0 0 0 6px rgba(47,158,99,0);}100%{box-shadow:0 0 0 0 rgba(47,158,99,0);}}
.run-meta{display:flex;flex-wrap:wrap;gap:4px 10px;font-size:10.5px;opacity:.72;margin:5px 0 0;}
.tr{margin-top:7px;}
.tr-head{font-size:10.5px;font-weight:650;opacity:.7;margin-bottom:3px;}
.tr-latest{margin:0;padding:6px 8px;border-radius:5px;background:light-dark(rgba(0,0,0,.05),rgba(0,0,0,.3));font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:10.5px;white-space:pre-wrap;word-break:break-word;max-height:150px;overflow:auto;}
.tr-history{margin-top:5px;font-size:10.5px;}
.tr-history summary{cursor:pointer;opacity:.65;}
.tr-event{padding:3px 0 3px 6px;border-left:2px solid light-dark(rgba(0,0,0,.12),rgba(255,255,255,.14));margin-top:3px;word-break:break-word;}
.tr-kind{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;opacity:.6;margin-right:5px;font-size:10px;}
.tr-empty,.empty{font-size:11px;opacity:.55;font-style:italic;padding:3px 0;}
.foot{margin-top:14px;font-size:11px;opacity:.6;line-height:1.6;}
.legend{display:flex;gap:10px;flex-wrap:wrap;margin-top:6px;}
`

/**
 * 渲染面板 HTML。
 *
 * @param {object} [options]
 * @param {string} [options.title]
 * @param {number} [options.refreshMs] - 前端轮询间隔
 * @returns {string}
 */
export function renderPanelHtml({ title = '🐺 狼群实时面板', refreshMs } = {}) {
  const refreshScript = typeof refreshMs === 'number' && refreshMs >= 500
    ? `<script>window.__WOLFPACK_REFRESH_MS__=${Math.trunc(refreshMs)}</script>`
    : ''
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>${PANEL_CSS}</style>
</head>
<body>
<div class="top">
  <h1>${title}</h1>
  <div class="meta">
    <span id="updated">正在加载…</span>
    <span id="totals"></span>
    <span id="hint" class="muted">只读面板：零 token，不进模型上下文</span>
    <button class="btn" id="refresh">刷新</button>
    <button class="btn" id="pause">暂停</button>
    <a class="btn" id="all" href="#">显示全部</a>
  </div>
</div>
<div id="error"></div>
<div id="workers"></div>
<div class="foot">
  两个工人分区独立显示：各自的运行、会话流水、停滞监控与 token 累计。
  <div class="legend">
    <span class="tag r-auto">自动轮换</span><span>狼群自动在两个工人之间轮流派活</span>
    <span class="tag r-auto">续跑沿用</span><span>同一 task_id 沿用上一轮工人的会话</span>
    <span class="tag r-fallback">回退</span><span>配置指定的工人不可用，自动改用另一个</span>
  </div>
  停滞监控只报警、永不自动终止；判据是工人自己还在不在写会话流水。
  工人健康：某工人坏过（没输出/超时/额度或中转池子耗尽/未登录）会自动进入冷却，
  下一轮改派另一个工人；两个都在冷却时仍硬试最早恢复的那个，绝不空转。
</div>
${refreshScript}
<script>${PANEL_CLIENT_SOURCE}</script>
</body>
</html>
`
}
