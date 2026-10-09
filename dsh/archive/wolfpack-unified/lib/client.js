/**
 * 狼群模式（Wolfpack Mode）— Client 半。
 *
 * 两处 UI，读写同一个 host 设置命名空间 `wolfpack`：
 *
 *   1. **输入框里的模式开关**（`conversation.input.right`）——主入口。
 *      狼群开关改变的是**整个会话**的行为，和 plan mode 同类；而且它有成本
 *      后果、会作废提示词前缀缓存。这类东西必须随时随地看得见、点得到，
 *      不能藏在两层菜单里：藏起来的结果就是「在错误的会话里开着它」。
 *
 *   2. **设置里的默认值行**（`settings.general.item`）——保留，但降级为
 *      「新会话的默认值 / 说明」。
 *
 * 以及两处 keyed 工具卡片（`tool.call.toolview`）：
 *   - wolf_status：展示委派台账任务列表（状态、轮次、verdict、token 等）。
 *   - wolf_kill：展示终止结果。
 *
 * 手写模块，无需打包器：DSH 的客户端模块契约是
 *   window.__ModuleLoader__.load({ id, factory })
 * 且 factory 返回 { name, inject, apply }。
 *
 * 重要：settingsScope 的 getSnapshot() 返回的是
 *   { status, value, base, user, revision, writable, mode }
 * 真正的设置值在 `snapshot.value` 里，不是快照顶层。
 */
window.__ModuleLoader__.load({
  id: 'dsh-wolfpack',
  factory: function (require) {
    'use strict'

    var React = require('react')

    var NS = 'wolfpack'

    var CSS = [
      /* 设置行 */
      '.wp-row{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:10px 0;}',
      '.wp-text{display:flex;flex-direction:column;gap:2px;min-width:0;}',
      '.wp-title{font-size:13px;font-weight:600;line-height:1.4;}',
      '.wp-desc{font-size:12px;opacity:.65;line-height:1.4;}',
      '.wp-switch{position:relative;flex:none;width:40px;height:22px;border-radius:11px;border:1px solid rgba(127,127,127,.45);background:rgba(127,127,127,.25);cursor:pointer;padding:0;transition:background .15s ease,border-color .15s ease;}',
      '.wp-switch.on{background:#2f9e63;border-color:#2f9e63;}',
      '.wp-switch[disabled]{opacity:.5;cursor:default;}',
      '.wp-knob{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;transition:transform .15s ease;box-shadow:0 1px 2px rgba(0,0,0,.35);}',
      '.wp-switch.on .wp-knob{transform:translateX(18px);}',
      /* 输入框里的模式开关：一枚小滑块（与设置页同一套语言）。
         容器默认完全融入界面——无边框、无底色；标签默认若隐若现，
         但**开启后直接完全展现**（模式生效时不该还要靠悬停才看得清）。
         悬停 / 键盘聚焦时才浮起一层极轻的底色与描边。

         ⚠️ 这里刻意**不用 :focus-within**：鼠标点一下按钮会让它一直保持
         聚焦，边框就挂在那儿直到你点别处。改用 :has(:focus-visible)——
         它只在键盘导航时命中。
         而且这两条必须**分开写**：逗号选择器列表里只要有一个浏览器不认识
         的选择器，整条规则会被丢弃，连悬停效果一起没。 */
      '.wp-mini{display:inline-flex;align-items:center;gap:7px;height:24px;padding:0 6px;border-radius:7px;border:1px solid transparent;background:transparent;transition:background .15s ease,border-color .15s ease;}',
      '.wp-mini:hover{background:rgba(127,127,127,.12);border-color:rgba(127,127,127,.2);}',
      '.wp-mini:has(:focus-visible){background:rgba(127,127,127,.12);border-color:rgba(127,127,127,.2);}',
      '.wp-mini-label{font-size:12px;line-height:1;opacity:.42;white-space:nowrap;transition:opacity .15s ease;}',
      '.wp-mini.on .wp-mini-label{opacity:1;}',
      '.wp-mini:hover .wp-mini-label{opacity:1;}',
      '.wp-mini:has(:focus-visible) .wp-mini-label{opacity:1;}',
      '.wp-mini-switch{position:relative;flex:none;width:30px;height:17px;border-radius:9px;border:1px solid rgba(127,127,127,.4);background:rgba(127,127,127,.22);cursor:pointer;padding:0;transition:background .15s ease,border-color .15s ease;}',
      '.wp-mini-switch.on{background:#2f9e63;border-color:#2f9e63;}',
      '.wp-mini-switch[disabled]{opacity:.4;cursor:default;}',
      '.wp-mini-knob{position:absolute;top:2px;left:2px;width:11px;height:11px;border-radius:50%;background:#fff;transition:transform .15s ease;box-shadow:0 1px 2px rgba(0,0,0,.3);}',
      '.wp-mini-switch.on .wp-mini-knob{transform:translateX(13px);}',
      /* 工具卡片（wolf_status / wolf_kill） */
      '.wp-card{font-size:12px;line-height:1.5;padding:8px 12px;border-radius:6px;background:rgba(127,127,127,.08);border:1px solid rgba(127,127,127,.15);margin:4px 0;}',
      '.wp-card.is-error{border-color:rgba(220,80,80,.4);}',
      '.wp-card-running{display:flex;align-items:center;gap:6px;opacity:.75;font-style:italic;}',
      '.wp-card-header{font-weight:600;margin-bottom:6px;display:flex;align-items:center;gap:6px;}',
      '.wp-card-header.error{color:#e07070;}',
      '.wp-card-err-mark{color:#e07070;}',
      '.wp-card-empty{opacity:.6;font-style:italic;padding:4px 0;}',
      '.wp-card-list{display:flex;flex-direction:column;gap:4px;}',
      '.wp-status-row{display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px;padding:3px 0;border-bottom:1px solid rgba(127,127,127,.08);font-size:11px;}',
      '.wp-status-row:last-child{border-bottom:none;}',
      '.wp-status-task-id{font-family:monospace;font-weight:600;opacity:.9;}',
      '.wp-status-round{opacity:.75;}',
      '.wp-verdict-badge{display:inline-block;padding:1px 5px;border-radius:3px;font-size:10px;font-weight:600;}',
      '.wp-verdict-badge.pass{color:#2f9e63;background:rgba(47,158,99,.15);}',
      '.wp-verdict-badge.fail{color:#e07070;background:rgba(224,112,112,.15);}',
      '.wp-verdict-badge.needs_revision{color:#e0a030;background:rgba(224,160,48,.15);}',
      '.wp-verdict-badge.unverified{color:#888;background:rgba(127,127,127,.15);}',
      '.wp-status-stop-reason{opacity:.7;font-family:monospace;background:rgba(127,127,127,.1);padding:0 4px;border-radius:2px;}',
      '.wp-status-tokens{opacity:.75;}',
      '.wp-status-running-tag{display:inline-block;padding:1px 5px;border-radius:3px;font-size:10px;}',
      '.wp-status-running-tag.active{color:#2f9e63;background:rgba(47,158,99,.15);}',
      '.wp-status-running-tag.idle{opacity:.6;}',
      '.wp-status-files{opacity:.75;}',
      '.wp-kill-success{color:#2f9e63;font-weight:500;}',
      '.wp-kill-fail{color:#e07070;font-weight:500;}',
      '.wp-card-fallback{margin:0;font-family:monospace;font-size:11px;white-space:pre-wrap;word-break:break-all;opacity:.85;}',
      /* 输入框 📊 实时面板入口按钮 */
      '.wp-live-btn{display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;padding:0;border:none;background:transparent;cursor:pointer;font-size:12px;line-height:1;border-radius:4px;opacity:.65;transition:opacity .15s ease,background .15s ease;}',
      '.wp-live-btn:hover{opacity:1;background:rgba(127,127,127,.18);}',
      '.wp-live-btn[disabled]{opacity:.25;cursor:default;}',
      /* 右侧栏实时面板 WolfLivePanel */
      '.wp-live-panel{display:flex;flex-direction:column;gap:10px;padding:12px;font-size:12px;line-height:1.5;color:inherit;height:100%;box-sizing:border-box;overflow-y:auto;}',
      '.wp-live-header{display:flex;align-items:center;justify-content:space-between;gap:8px;padding-bottom:8px;border-bottom:1px solid rgba(127,127,127,.15);}',
      '.wp-live-title{font-size:13px;font-weight:600;display:flex;align-items:center;gap:6px;}',
      '.wp-live-header-actions{display:flex;align-items:center;gap:8px;}',
      '.wp-live-updated{font-size:11px;opacity:.55;}',
      '.wp-live-refresh-btn{font-size:11px;padding:2px 6px;border-radius:4px;border:1px solid rgba(127,127,127,.25);background:rgba(127,127,127,.1);cursor:pointer;color:inherit;transition:background .15s ease;}',
      '.wp-live-refresh-btn:hover{background:rgba(127,127,127,.22);}',
      '.wp-live-error{padding:6px 10px;border-radius:4px;background:rgba(224,112,112,.12);border:1px solid rgba(224,112,112,.3);color:#e07070;font-size:11px;}',
      '.wp-live-empty{padding:16px 8px;text-align:center;opacity:.6;font-style:italic;}',
      '.wp-live-runs-list{display:flex;flex-direction:column;gap:8px;}',
      '.wp-live-card{border-radius:8px;padding:10px;background:rgba(127,127,127,.06);border:1px solid rgba(127,127,127,.15);transition:border-color .2s ease,box-shadow .2s ease;}',
      '.wp-live-card.running{border-color:rgba(47,158,99,.35);box-shadow:0 0 8px rgba(47,158,99,.08);animation:wp-card-glow 3s ease-in-out infinite alternate;}',
      '.wp-live-card.idle{opacity:.85;}',
      '.wp-live-card-head{display:flex;align-items:center;gap:8px;margin-bottom:6px;flex-wrap:wrap;}',
      '.wp-live-dot{width:8px;height:8px;border-radius:50%;flex:none;}',
      '.wp-live-dot.running{background:#2f9e63;box-shadow:0 0 0 0 rgba(47,158,99,.7);animation:wp-pulse 1.5s infinite;}',
      '.wp-live-dot.idle{background:#888;opacity:.5;}',
      '.wp-live-task-id{font-family:monospace;font-weight:600;font-size:12px;opacity:.95;}',
      '.wp-live-status-tag{display:inline-block;padding:1px 5px;border-radius:3px;font-size:10px;}',
      '.wp-live-status-tag.active{color:#2f9e63;background:rgba(47,158,99,.15);}',
      '.wp-live-status-tag.idle{opacity:.6;background:rgba(127,127,127,.12);}',
      '.wp-live-round{font-size:11px;opacity:.75;}',
      '.wp-live-step{font-size:11px;opacity:.75;}',
      '.wp-live-card-meta{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:11px;margin-bottom:8px;padding-bottom:6px;border-bottom:1px solid rgba(127,127,127,.08);}',
      '.wp-live-elapsed{opacity:.75;}',
      '.wp-live-finished{opacity:.6;}',
      '.wp-live-tokens{opacity:.75;}',
      '.wp-live-stop-reason{opacity:.7;font-family:monospace;background:rgba(127,127,127,.1);padding:0 4px;border-radius:2px;}',
      '.wp-live-transcript-section{margin-top:6px;}',
      '.wp-live-transcript-head{font-size:11px;font-weight:600;opacity:.8;margin-bottom:4px;display:flex;align-items:center;gap:4px;flex-wrap:wrap;}',
      '.wp-live-transcript-note{font-size:10px;opacity:.55;font-weight:normal;margin-left:4px;}',
      '.wp-live-thinking-dots{display:inline-block;animation:wp-blink 1.2s infinite;}',
      '.wp-live-thinking-block{margin:0;padding:6px 8px;border-radius:4px;background:rgba(0,0,0,.15);font-family:monospace;font-size:11px;white-space:pre-wrap;word-break:break-all;line-height:1.4;opacity:.9;}',
      '.wp-live-transcript-reason{font-size:11px;opacity:.65;font-style:italic;padding:2px 0;}',
      '.wp-live-transcript-empty{font-size:11px;opacity:.5;font-style:italic;padding:2px 0;}',
      '.wp-live-events-details{margin-top:6px;font-size:11px;}',
      '.wp-live-events-details summary{cursor:pointer;opacity:.65;user-select:none;margin-bottom:4px;}',
      '.wp-live-events-details summary:hover{opacity:1;}',
      '.wp-live-history-list{display:flex;flex-direction:column;gap:4px;padding-left:6px;border-left:2px solid rgba(127,127,127,.2);margin-top:4px;}',
      '.wp-live-history-item{font-size:11px;line-height:1.4;word-break:break-all;}',
      '.wp-live-history-kind{font-family:monospace;opacity:.65;font-size:10px;margin-right:4px;}',
      '@keyframes wp-pulse{0%{transform:scale(.95);box-shadow:0 0 0 0 rgba(47,158,99,.7);}70%{transform:scale(1);box-shadow:0 0 0 6px rgba(47,158,99,0);}100%{transform:scale(.95);box-shadow:0 0 0 0 rgba(47,158,99,0);}}',
      '@keyframes wp-card-glow{0%{border-color:rgba(47,158,99,.25);box-shadow:0 0 4px rgba(47,158,99,.05);}100%{border-color:rgba(47,158,99,.5);box-shadow:0 0 10px rgba(47,158,99,.15);}}',
      '@keyframes wp-blink{0%,100%{opacity:.2;}50%{opacity:1;}}',
    ].join('\n')

    var inject = ['slots', 'settingsScope']

    /** 快照里的真实设置值（`value` 才是命名空间对象）。 */
    function valueOf(snapshot) {
      if (snapshot === null || typeof snapshot !== 'object') return undefined
      return snapshot.value
    }

    function apply(ctx) {
      var slots = ctx.get('slots')
      var settingsScope = ctx.get('settingsScope')
      if (slots === undefined || settingsScope === undefined) {
        console.error('wolfpack: slots/settingsScope unavailable')
        return
      }

      var scope = settingsScope.bind({ namespace: NS })

      ctx.effect(function () {
        var style = document.createElement('style')
        style.textContent = CSS
        document.head.appendChild(style)
        return function () { style.remove() }
      }, 'wolfpack: styles')

      var navRef = null
      var navListeners = []
      var subscribeNav = function (listener) {
        navListeners.push(listener)
        return function () {
          var idx = navListeners.indexOf(listener)
          if (idx !== -1) navListeners.splice(idx, 1)
        }
      }

      if (typeof ctx.inject === 'function') {
        ctx.inject(['sidebarRight'], function (navCtx) {
          navRef = (navCtx && navCtx.sidebarRight) ? navCtx.sidebarRight : null
          for (var i = 0; i < navListeners.length; i++) {
            try { navListeners[i]() } catch (_) {}
          }
        })
      }

      /**
       * 两处 UI 共用的开关状态。订阅同一份快照，任一处切换两边同时更新——
       * 设置行和输入框开关不会互相说谎。
       */
      function useWolfpack() {
        var state = React.useState(function () { return scope.getSnapshot() })
        var snap = state[0]
        var setSnap = state[1]

        React.useEffect(function () {
          setSnap(scope.getSnapshot())
          return scope.subscribe(function () { setSnap(scope.getSnapshot()) })
        }, [])

        var ready = snap !== null && typeof snap === 'object' && snap.status === 'ready'
        var writable = snap !== null && typeof snap === 'object' && snap.writable === true
        var value = valueOf(snap)
        var on = value !== null && typeof value === 'object' && value.enabled === true

        var toggle = function () {
          if (!ready || !writable) return
          Promise.resolve(scope.set('enabled', !on)).catch(function (error) {
            console.error('wolfpack: set failed', error)
          })
        }

        return { snap: snap, ready: ready, writable: writable, on: on, toggle: toggle }
      }

      /** 格式化 token 数（K/M 缩写）。 */
      function formatTokens(n) {
        if (n === null || n === undefined || typeof n !== 'number' || isNaN(n)) return '—'
        if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M'
        if (n >= 1000) return Math.round(n / 1000) + 'K'
        return String(n)
      }

      /** 提取 block 的兜底文本。 */
      function extractResultText(block) {
        if (!block) return ''
        var content = block.content
        if (Array.isArray(content)) {
          var parts = []
          for (var i = 0; i < content.length; i++) {
            var item = content[i]
            if (item && item.type === 'text' && typeof item.text === 'string') {
              parts.push(item.text)
            } else if (item !== null && item !== undefined) {
              parts.push(typeof item === 'string' ? item : JSON.stringify(item, null, 2))
            }
          }
          if (parts.length > 0) return parts.join('\n')
        }
        if (block.error) {
          var errParts = []
          if (block.error.name) errParts.push(block.error.name)
          if (block.error.code) errParts.push(block.error.code)
          if (block.error.message) errParts.push(block.error.message)
          if (errParts.length > 0) return errParts.join(': ')
        }
        return ''
      }

      /**
       * wolf_status 专用工具卡片。
       * 纯 props 组件：不读 ctx、不订阅、不发 RPC。
       */
      function WolfStatusCard(props) {
        var block = (props && props.block) || {}
        var isRunning = !('kind' in block)
        var isError = !!block.isError

        if (isRunning) {
          return React.createElement('div', { className: 'wp-card wp-status-card' + (isError ? ' is-error' : '') },
            React.createElement('div', { className: 'wp-card-running' }, '\uD83D\uDC3A wolf_status 运行中…')
          )
        }

        var meta = block.meta
        var hasValidMeta = meta !== null && typeof meta === 'object' && Array.isArray(meta.tasks)
        if (!hasValidMeta) {
          return React.createElement('div', { className: 'wp-card wp-status-card' + (isError ? ' is-error' : '') },
            React.createElement('pre', { className: 'wp-card-fallback' }, extractResultText(block))
          )
        }

        var tasks = meta.tasks
        var headerText = '\uD83D\uDC3A 运行台账 · 任务 ' + tasks.length + ' 个' + (meta.truncated ? '（已截断）' : '')

        var headerEl = React.createElement('div', { className: 'wp-card-header' + (isError ? ' error' : '') },
          isError ? React.createElement('span', { className: 'wp-card-err-mark' }, '❌ ') : null,
          headerText
        )

        if (tasks.length === 0) {
          return React.createElement('div', { className: 'wp-card wp-status-card' + (isError ? ' is-error' : '') },
            headerEl,
            React.createElement('div', { className: 'wp-card-empty' }, '（台账里还没有任何委派记录）')
          )
        }

        var rows = tasks.map(function (task, idx) {
          var key = task && task.task_id ? task.task_id : String(idx)
          var taskId = task && task.task_id ? task.task_id : '—'
          var round = (task && task.round !== undefined && task.round !== null) ? task.round : '—'

          var verdict = task ? (task.last_verdict || task.verdict) : undefined
          var verdictText = verdict === 'pass'
            ? 'pass'
            : verdict === 'fail'
              ? 'fail'
              : verdict === 'needs_revision'
                ? 'needs_revision'
                : '尚未验收'
          var verdictClass = 'wp-verdict-badge ' + (
            verdict === 'pass'
              ? 'pass'
              : verdict === 'fail'
                ? 'fail'
                : verdict === 'needs_revision'
                  ? 'needs_revision'
                  : 'unverified'
          )

          var stopReason = task ? (task.last_stop_reason || task.stop_reason) : undefined
          var tokensVal = task ? (typeof task.total_tokens === 'number' ? task.total_tokens : task.tokens) : undefined
          var isTaskRunning = task ? !!task.running : false
          var runningText = isTaskRunning ? '正在跑' : '未在跑'
          var runningClass = 'wp-status-running-tag ' + (isTaskRunning ? 'active' : 'idle')
          var filesCount = (task && task.changed_files_count !== undefined && task.changed_files_count !== null)
            ? task.changed_files_count
            : 0

          return React.createElement('div', { key: key, className: 'wp-status-row' },
            React.createElement('span', { className: 'wp-status-task-id' }, taskId),
            React.createElement('span', { className: 'wp-status-round' }, '第 ' + round + ' 轮'),
            React.createElement('span', { className: verdictClass }, verdictText),
            stopReason ? React.createElement('span', { className: 'wp-status-stop-reason' }, String(stopReason)) : null,
            React.createElement('span', { className: 'wp-status-tokens' }, formatTokens(tokensVal) + ' tokens'),
            React.createElement('span', { className: runningClass }, runningText),
            React.createElement('span', { className: 'wp-status-files' }, '改动 ' + filesCount + ' 个文件')
          )
        })

        return React.createElement('div', { className: 'wp-card wp-status-card' + (isError ? ' is-error' : '') },
          headerEl,
          React.createElement('div', { className: 'wp-card-list' }, rows)
        )
      }

      /**
       * wolf_kill 专用工具卡片。
       * 纯 props 组件：不读 ctx、不订阅、不发 RPC。
       */
      function WolfKillCard(props) {
        var block = (props && props.block) || {}
        var isRunning = !('kind' in block)
        var isError = !!block.isError

        if (isRunning) {
          return React.createElement('div', { className: 'wp-card wp-kill-card' + (isError ? ' is-error' : '') },
            React.createElement('div', { className: 'wp-card-running' }, '\uD83D\uDC3A wolf_kill 运行中…')
          )
        }

        var meta = block.meta
        if (meta && typeof meta === 'object' && typeof meta.ok === 'boolean') {
          if (meta.ok === true) {
            var runIdPart = meta.run_id ? '（run_id=' + meta.run_id + '）' : ''
            var successMsg = '✅ 已终止 task_id=' + (meta.task_id !== undefined ? meta.task_id : '—') + runIdPart
            return React.createElement('div', { className: 'wp-card wp-kill-card' },
              React.createElement('div', { className: 'wp-kill-success' }, successMsg)
            )
          } else {
            var reason = meta.reason || '未知原因'
            var failMsg = '❌ 终止失败——' + reason
            return React.createElement('div', { className: 'wp-card wp-kill-card is-error' },
              React.createElement('div', { className: 'wp-kill-fail' }, failMsg)
            )
          }
        }

        // 畸形或缺失 meta 兜底
        return React.createElement('div', { className: 'wp-card wp-kill-card' + (isError ? ' is-error' : '') },
          React.createElement('pre', { className: 'wp-card-fallback' }, extractResultText(block))
        )
      }

      /**
       * 格式化时长（ms 换算为 s/m/h）。
       *
       * @param {number|null|undefined} ms
       * @param {string} [fallback] - 无数据时的文案，缺省 `'—'`
       */
      function formatDuration(ms, fallback) {
        if (ms === null || ms === undefined || typeof ms !== 'number' || isNaN(ms)) {
          return fallback === undefined ? '—' : fallback
        }
        var s = Math.floor(ms / 1000)
        if (s < 60) return s + 's'
        var m = Math.floor(s / 60)
        var remS = s % 60
        if (m < 60) return m + 'm ' + remS + 's'
        var h = Math.floor(m / 60)
        var remM = m % 60
        return h + 'h ' + remM + 'm'
      }

      /** 格式化时间戳为 hh:mm:ss。 */
      function formatTime(ts) {
        if (!ts) return '—'
        try {
          var d = new Date(ts)
          var pad = function (n) { return n < 10 ? '0' + n : String(n) }
          return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds())
        } catch {
          return String(ts)
        }
      }

      /**
       * 结束时刻：当天只给 hh:mm:ss，跨天补上 MM-DD——
       * 否则「昨天 22:10 结束」会看起来像刚跑完。
       */
      function formatFinishedAt(ts) {
        try {
          var d = new Date(ts)
          var today = new Date()
          var pad = function (n) { return n < 10 ? '0' + n : String(n) }
          var hms = pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds())
          var sameDay = d.getFullYear() === today.getFullYear()
            && d.getMonth() === today.getMonth()
            && d.getDate() === today.getDate()
          return sameDay ? hms : (pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + hms)
        } catch {
          return String(ts)
        }
      }

      /**
       * 右侧栏实时面板 WolfLivePanel。
       * 纯 props / 纯读：不读 ctx 之外的东西、不发 RPC、不写任何数据。
       */
      function WolfLivePanel(props) {
        var propData = (props && (props.payload || props.data || props.liveData)) || null
        var propError = (props && props.error) || null

        /** 「显示全部」请求的条数；与宿主 MAX_LIVE_RUNS_HARD 对齐，超出会被宿主夹回。 */
        var EXPAND_LIMIT = 50

        var stateData = React.useState(function () { return propData })
        var data = stateData[0] !== null ? stateData[0] : propData
        var setData = stateData[1]

        var stateError = React.useState(function () { return propError })
        var error = stateError[0] !== null ? stateError[0] : propError
        var setError = stateError[1]

        var stateNow = React.useState(function () { return Date.now() })
        var now = stateNow[0]
        var setNow = stateNow[1]

        var stateLastUpdated = React.useState(function () { return propData ? Date.now() : null })
        var lastUpdated = stateLastUpdated[0]
        var setLastUpdated = stateLastUpdated[1]

        var fetchRef = React.useState(function () { return { fn: null } })[0]

        // 最近一次成功的数据：tick 用它判断「有没有任务在跑」，没在跑就不必每秒重渲染。
        var dataRef = React.useState(function () { return { current: null } })[0]

        // 「显示全部」条数：null = 默认（宿主只给最近 8 个）；数字 = 请求该条数（宿主硬上限 50）。
        var stateLimit = React.useState(function () { return null })
        var limit = stateLimit[0]
        var setLimit = stateLimit[1]
        var limitRef = React.useState(function () { return { current: null } })[0]

        /** 该 payload 里有没有正在跑的 run（决定轮询节奏与是否需要每秒 tick）。 */
        function hasRunningRun(payload) {
          if (!payload || !Array.isArray(payload.runs)) return false
          for (var i = 0; i < payload.runs.length; i++) {
            if (payload.runs[i] && payload.runs[i].status === 'running') return true
          }
          return false
        }

        React.useEffect(function () {
          var disposed = false
          var pollTimer = null
          var tickTimer = null
          // 有任务在跑：1.5s（要看着它动）；没有任务在跑：5s。
          // 面板闲着时没必要每 1.5s 把台账和一批 transcript 再读一遍。
          var RUNNING_DELAY_MS = 1500
          var IDLE_DELAY_MS = 5000
          var currentDelay = RUNNING_DELAY_MS

          function scheduleNext(delay) {
            if (disposed) return
            if (pollTimer !== null) {
              clearTimeout(pollTimer)
              pollTimer = null
            }
            if (typeof document !== 'undefined' && document.hidden) {
              return
            }
            pollTimer = setTimeout(function () {
              pollTimer = null
              doFetch()
            }, delay)
            if (pollTimer && typeof pollTimer.unref === 'function') {
              pollTimer.unref()
            }
          }

          function doFetch() {
            if (disposed) return
            if (typeof fetch !== 'function') return
            var url = '/wolfpack/live'
            if (limitRef.current !== null) url += '?limit=' + limitRef.current
            return Promise.resolve().then(function () {
              return fetch(url, { cache: 'no-store' })
            }).then(function (res) {
              if (!res.ok) {
                throw new Error('HTTP ' + res.status + (res.statusText ? ' ' + res.statusText : ''))
              }
              return res.json()
            }).then(function (json) {
              if (disposed) return
              setData(json)
              dataRef.current = json
              setError(null)
              setLastUpdated(Date.now())
              currentDelay = hasRunningRun(json) ? RUNNING_DELAY_MS : IDLE_DELAY_MS
              scheduleNext(currentDelay)
            }).catch(function (err) {
              if (disposed) return
              var msg = err && err.message ? err.message : String(err)
              setError(msg)
              currentDelay = Math.min(currentDelay * 2, 12000)
              scheduleNext(currentDelay)
            })
          }

          fetchRef.fn = function () {
            currentDelay = RUNNING_DELAY_MS
            doFetch()
          }

          // 每秒 tick 只服务于「已跑时长」这个活时钟；
          // 没有任务在跑时完全不必每秒重渲染。
          tickTimer = setInterval(function () {
            if (hasRunningRun(dataRef.current)) {
              setNow(Date.now())
            }
          }, 1000)
          if (tickTimer && typeof tickTimer.unref === 'function') {
            tickTimer.unref()
          }

          if (typeof document === 'undefined' || !document.hidden) {
            doFetch()
          }

          function onVisibilityChange() {
            if (disposed) return
            if (typeof document !== 'undefined' && !document.hidden) {
              currentDelay = RUNNING_DELAY_MS
              doFetch()
            } else {
              if (pollTimer !== null) {
                clearTimeout(pollTimer)
                pollTimer = null
              }
            }
          }

          if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
            document.addEventListener('visibilitychange', onVisibilityChange)
          }

          return function () {
            disposed = true
            fetchRef.fn = null
            if (pollTimer !== null) {
              clearTimeout(pollTimer)
              pollTimer = null
            }
            if (tickTimer !== null) {
              clearInterval(tickTimer)
              tickTimer = null
            }
            if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
              document.removeEventListener('visibilitychange', onVisibilityChange)
            }
          }
        }, [])

        var runs = (data && Array.isArray(data.runs)) ? data.runs : []
        var ledgerTotal = (data && typeof data.ledger_total === 'number') ? data.ledger_total : 0
        var runsCount = runs.length
        if (data !== null) dataRef.current = data

        var runningCount = 0
        for (var rIdx = 0; rIdx < runs.length; rIdx++) {
          if (runs[rIdx] && runs[rIdx].status === 'running') {
            runningCount++
          }
        }

        // 头部: 🐺 狼群 · 并行运行 N 个（共 M 个任务） + 最后更新时间 + 手动刷新按钮
        var titleText = '\uD83D\uDC3A 狼群 \u00B7 并行运行 ' + runningCount + ' 个' + (runsCount > 0 ? '（共 ' + runsCount + ' 个任务）' : '')
        // 台账里还有没被默认条数盖住的任务时，给一个出口——否则第 9 个之后的任务根本看不到。
        var canExpand = ledgerTotal > runsCount
        var expandBtn = (canExpand || limit !== null)
          ? React.createElement('button', {
              type: 'button',
              className: 'wp-live-refresh-btn',
              title: limit === null ? ('显示全部 ' + ledgerTotal + ' 个任务') : '收起，只显示最近 8 个',
              onClick: function () {
                var next = limit === null ? EXPAND_LIMIT : null
                limitRef.current = next
                setLimit(next)
                if (typeof fetchRef.fn === 'function') fetchRef.fn()
              },
            }, limit === null ? ('\uD83D\uDCC2 显示全部 ' + ledgerTotal + ' 个') : '收起')
          : null
        var headChildren = [
          React.createElement('div', { key: 'title', className: 'wp-live-title' }, titleText),
          React.createElement('div', { key: 'actions', className: 'wp-live-header-actions' },
            lastUpdated ? React.createElement('span', { className: 'wp-live-updated' }, formatTime(lastUpdated)) : null,
            expandBtn,
            React.createElement('button', {
              type: 'button',
              className: 'wp-live-refresh-btn',
              title: '立即刷新',
              onClick: function () {
                if (typeof fetchRef.fn === 'function') fetchRef.fn()
              },
            }, '\uD83D\uDD04 刷新')
          )
        ]
        var headerEl = React.createElement('div', { className: 'wp-live-header' }, headChildren)

        // 错误行
        var errorEl = error ? React.createElement('div', { className: 'wp-live-error' }, '拉取失败：' + error) : null

        // 主体: 空态或运行卡片列表
        var bodyEl
        if (runs.length === 0) {
          bodyEl = React.createElement('div', { className: 'wp-live-empty' },
            '当前没有在跑的 agy 任务（台账总数：' + ledgerTotal + '）'
          )
        } else {
          var cards = runs.map(function (run, idx) {
            var key = run && run.task_id ? run.task_id : String(idx)
            var taskId = run && run.task_id ? run.task_id : '—'
            var isRunning = run ? run.status === 'running' : false
            var round = (run && run.round !== undefined && run.round !== null) ? run.round : '—'

            var transcript = run ? run.transcript : undefined
            var stepIndex = (transcript && typeof transcript.step_index === 'number')
              ? transcript.step_index
              : ((run && typeof run.step_index === 'number') ? run.step_index : null)
            var stepText = '第 ' + (stepIndex !== null && stepIndex !== undefined ? stepIndex : '—') + ' 步'

            // 时长：**只有「正在跑」才是活时钟**（每秒本地 tick 重算 now - started_at）；
            // 已结束的任务用宿主给的**整次运行总耗时**（台账 durationMs，固定不变）。
            // 绝不能对已结束的任务退回 `now - started_at`：那是「距最后活动过了多久」，
            // 会变成永远在涨的假耗时。没有真实耗时数据时如实显示未知，不编数字。
            var elapsedMs = null
            var elapsedLive = false
            if (run) {
              if (isRunning && typeof run.started_at === 'number') {
                elapsedMs = Math.max(0, now - run.started_at)
                elapsedLive = true
              } else if (typeof run.elapsed_ms === 'number') {
                elapsedMs = run.elapsed_ms
              }
            }

            var tokensVal = run ? (typeof run.total_tokens === 'number' ? run.total_tokens : run.tokens) : undefined

            // verdict 徽标
            var verdict = run ? (run.last_verdict || run.verdict) : undefined
            var verdictText = verdict === 'pass'
              ? 'pass'
              : verdict === 'fail'
                ? 'fail'
                : verdict === 'needs_revision'
                  ? 'needs_revision'
                  : '未验收'
            var verdictClass = 'wp-verdict-badge ' + (
              verdict === 'pass'
                ? 'pass'
                : verdict === 'fail'
                  ? 'fail'
                  : verdict === 'needs_revision'
                    ? 'needs_revision'
                    : 'unverified'
            )

            var stopReason = run ? (run.last_stop_reason || run.stop_reason) : undefined

            // 卡片头部: 状态点 (running 脉冲动画) + task_id (等宽) + 运行状态文案 + 第 N 轮 + 第 N 步
            var cardHead = React.createElement('div', { className: 'wp-live-card-head' },
              React.createElement('span', { className: 'wp-live-dot ' + (isRunning ? 'running' : 'idle') }),
              React.createElement('span', { className: 'wp-live-task-id' }, taskId),
              React.createElement('span', { className: 'wp-live-status-tag ' + (isRunning ? 'active' : 'idle') }, isRunning ? '正在跑' : '未在跑'),
              React.createElement('span', { className: 'wp-live-round' }, '第 ' + round + ' 轮'),
              React.createElement('span', { className: 'wp-live-step' }, stepText)
            )

            // 卡片元信息: 已跑时长/总耗时 + 结束时刻 + tokens + verdict + stop_reason
            var finishedAt = (run && typeof run.finished_at === 'number') ? run.finished_at : null
            var cardMeta = React.createElement('div', { className: 'wp-live-card-meta' },
              React.createElement('span', { className: 'wp-live-elapsed' },
                (elapsedLive ? '已跑 ' : '耗时 ') + formatDuration(elapsedMs, '未知')),
              finishedAt !== null
                ? React.createElement('span', { className: 'wp-live-finished' }, '结束于 ' + formatFinishedAt(finishedAt))
                : null,
              React.createElement('span', { className: 'wp-live-tokens' }, formatTokens(tokensVal) + ' tokens'),
              React.createElement('span', { className: verdictClass }, verdictText),
              stopReason ? React.createElement('span', { className: 'wp-live-stop-reason' }, String(stopReason)) : null
            )

            // 思考过程 (transcript)
            var transcriptEl = null

            if (!transcript) {
              transcriptEl = React.createElement('div', { className: 'wp-live-transcript-empty' }, '（无思考记录）')
            } else if (transcript.available === false) {
              var reasonText = transcript.reason || '未知原因'
              transcriptEl = React.createElement('div', { className: 'wp-live-transcript-reason' }, '思考记录不可用：' + reasonText)
            } else if (Array.isArray(transcript.events) && transcript.events.length > 0) {
              var events = transcript.events
              var latestEvent = events[events.length - 1]
              var latestText = latestEvent ? (latestEvent.text || '') : ''

              var earlierEvents = events.slice(0, events.length - 1)
              var historyEl = null
              if (earlierEvents.length > 0) {
                var historyItems = earlierEvents.map(function (ev, hIdx) {
                  var kindTag = ev.kind ? '[' + ev.kind + '] ' : ''
                  return React.createElement('div', { key: String(hIdx), className: 'wp-live-history-item' },
                    React.createElement('span', { className: 'wp-live-history-kind' }, kindTag),
                    ev.text || ''
                  )
                })
                historyEl = React.createElement('details', { className: 'wp-live-events-details' },
                  React.createElement('summary', null, '更早思考（' + earlierEvents.length + ' 条）'),
                  React.createElement('div', { className: 'wp-live-history-list' }, historyItems)
                )
              }

              transcriptEl = React.createElement('div', { className: 'wp-live-transcript-section' },
                React.createElement('div', { className: 'wp-live-transcript-head' },
                  '最近思考',
                  isRunning ? React.createElement('span', { className: 'wp-live-thinking-dots' }, '…') : null,
                  React.createElement('span', { className: 'wp-live-transcript-note' }, '（思考在每步完成后写入，显示的是最近完成的一步）')
                ),
                React.createElement('pre', { className: 'wp-live-thinking-block' }, latestText),
                historyEl
              )
            } else {
              transcriptEl = React.createElement('div', { className: 'wp-live-transcript-empty' }, '（暂无思考记录）')
            }

            return React.createElement('div', {
              key: key,
              className: 'wp-live-card' + (isRunning ? ' running' : ' idle'),
            }, cardHead, cardMeta, transcriptEl)
          })

          bodyEl = React.createElement('div', { className: 'wp-live-runs-list' }, cards)
        }

        return React.createElement('div', { className: 'wp-live-panel' },
          headerEl,
          errorEl,
          bodyEl
        )
      }

      /** 输入框里的模式开关——主入口，状态永远可见。 */
      function WolfpackChip() {
        var wolf = useWolfpack()

        var navState = React.useState(function () { return navRef })
        var currentNav = navState[0]
        var setNav = navState[1]

        var tipState = React.useState(null)
        var inlineTip = tipState[0]
        var setInlineTip = tipState[1]

        React.useEffect(function () {
          setNav(navRef)
          return subscribeNav(function () {
            setNav(navRef)
          })
        }, [])

        var title = !wolf.ready
          ? '狼群模式：正在加载设置…'
          : !wolf.writable
            ? '狼群模式：设置只读，改不动'
            : wolf.on
              ? '狼群模式已开启：我当队长调度，重活通过 wolf_delegate 派给 agy，验收由代码跑；运行状态看 wolf_status / wolf_kill 的工具卡片；要终止某一轮，让我调用 wolf_kill。点击关闭。'
              : '狼群模式已关闭：所有活我自己干。点击开启。'

        var activeNav = currentNav || navRef
        var canOpenPanel = activeNav !== null && typeof activeNav === 'object' && typeof activeNav.openTab === 'function'
        var panelTitle = inlineTip
          ? ('右侧栏不可用（' + inlineTip + '）')
          : (canOpenPanel ? '打开狼群实时面板' : '右侧栏服务不可用')

        var openLivePanel = function () {
          var targetNav = navRef || currentNav
          if (!targetNav || typeof targetNav.openTab !== 'function') {
            console.error('wolfpack: sidebarRight 服务不可用')
            setInlineTip('右侧栏不可用')
            if (typeof setTimeout === 'function') {
              var t = setTimeout(function () {
                setInlineTip(null)
              }, 3000)
              if (t && typeof t.unref === 'function') t.unref()
            }
            return
          }
          try {
            targetNav.openTab('wolfpack', { revealIfOpened: true })
          } catch (e) {
            console.error('wolfpack: openTab failed', e)
          }
        }

        var btnContent = inlineTip ? '不可用' : '\uD83D\uDCCA'

        return React.createElement('div', { className: wolf.on ? 'wp-mini on' : 'wp-mini' },
          React.createElement('span', { className: 'wp-mini-label' }, '\uD83D\uDC3A 狼群'),
          React.createElement('button', {
            type: 'button',
            className: wolf.on ? 'wp-mini-switch on' : 'wp-mini-switch',
            role: 'switch',
            disabled: !wolf.ready || !wolf.writable,
            'aria-checked': wolf.on ? 'true' : 'false',
            'aria-label': '狼群模式',
            title: title,
            onClick: wolf.toggle,
          }, React.createElement('span', { className: 'wp-mini-knob' })),
          React.createElement('button', {
            type: 'button',
            className: 'wp-live-btn',
            disabled: !canOpenPanel,
            title: panelTitle,
            'aria-label': '狼群实时面板',
            onClick: openLivePanel,
          }, btnContent)
        )
      }

      /** 设置里的默认值行——保留，但语义降级为「默认值 / 说明」。 */
      function WolfpackRow() {
        var wolf = useWolfpack()

        var desc
        if (!wolf.ready) {
          desc = '正在加载设置…（' + (wolf.snap !== null && typeof wolf.snap === 'object' ? String(wolf.snap.status) : 'no-snapshot') + '）'
        } else if (!wolf.writable) {
          desc = '设置当前只读，改不动。'
        } else if (wolf.on) {
          desc = '已开启：我当队长调度，重活通过 wolf_delegate 派给 agy（走订阅配额），验收由代码跑；运行状态看 wolf_status / wolf_kill 的工具卡片；要终止某一轮，让我调用 wolf_kill。'
        } else {
          desc = '关闭：所有活我自己干。'
        }

        return React.createElement('div', { className: 'wp-row' },
          React.createElement('div', { className: 'wp-text' },
            React.createElement('div', { className: 'wp-title' }, '\uD83D\uDC3A 狼群模式 / Wolfpack'),
            React.createElement('div', { className: 'wp-desc' }, desc),
            React.createElement('div', { className: 'wp-desc' }, '输入框右侧也有同一个开关，随手可切。')
          ),
          React.createElement('button', {
            type: 'button',
            className: wolf.on ? 'wp-switch on' : 'wp-switch',
            role: 'switch',
            disabled: !wolf.ready || !wolf.writable,
            'aria-checked': wolf.on ? 'true' : 'false',
            'aria-label': '狼群模式',
            onClick: wolf.toggle,
          }, React.createElement('span', { className: 'wp-knob' }))
        )
      }

      ctx.effect(function () {
        return slots.inject('conversation.input.right', function () {
          return slots.register({
            name: 'conversation.input.right',
            id: 'wolfpack',
            order: 30,
            label: '狼群模式',
          }, WolfpackChip)
        })
      }, 'wolfpack: composer chip')

      ctx.effect(function () {
        return slots.inject('settings.general.item', function () {
          return slots.register({
            name: 'settings.general.item',
            id: 'wolfpack',
            order: 30,
          }, WolfpackRow)
        })
      }, 'wolfpack: settings row')

      ctx.effect(function () {
        return slots.inject('tool.call.toolview', function () {
          return slots.register({
            name: 'tool.call.toolview',
            key: 'wolf_status',
          }, WolfStatusCard)
        })
      }, 'wolfpack: wolf_status card')

      ctx.effect(function () {
        return slots.inject('tool.call.toolview', function () {
          return slots.register({
            name: 'tool.call.toolview',
            key: 'wolf_kill',
          }, WolfKillCard)
        })
      }, 'wolfpack: wolf_kill card')

      if (typeof ctx.inject === 'function') {
        ctx.inject(['sidebarRightTabs'], function (tabCtx) {
          ctx.effect(function () {
            if (!tabCtx || !tabCtx.sidebarRightTabs || typeof tabCtx.sidebarRightTabs.register !== 'function') return
            return tabCtx.sidebarRightTabs.register({
              id: 'dsh-wolfpack',
              kind: 'wolfpack',
              title: function () { return '狼群' },
            })
          }, 'wolfpack: sidebar tab type')

          ctx.effect(function () {
            return slots.inject('sidebar.right.pane.tab', function () {
              return slots.register({
                name: 'sidebar.right.pane.tab',
                key: 'dsh-wolfpack',
              }, WolfLivePanel)
            })
          }, 'wolfpack: sidebar live panel')
        })
      }
    }

    return { name: NS, inject: inject, apply: apply }
  },
})
