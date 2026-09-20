/* 狼群实时面板 — 浏览器端（无构建、无依赖）。
 *
 * 数据只来自只读路由 GET /wolfpack/live（零 token，永不进模型上下文）。
 * 两个工人**分开展示**：agy 与 claude 各占一个分区，各自显示运行、停滞监控、
 * token 累计、最近一次结果与路由原因。
 */
(function () {
  'use strict'

  var LIVE_URL = '/wolfpack/live'
  var refreshMs = (typeof window.__WOLFPACK_REFRESH_MS__ === 'number' && window.__WOLFPACK_REFRESH_MS__ >= 500)
    ? window.__WOLFPACK_REFRESH_MS__
    : 3000
  var timer = null
  var paused = false
  var lastPayload = null

  function el(id) {
    return document.getElementById(id)
  }

  function formatTokens(n) {
    if (typeof n !== 'number' || isNaN(n)) return '—'
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M'
    if (n >= 1000) return Math.round(n / 1000) + 'K'
    return String(n)
  }

  function formatDuration(ms) {
    if (typeof ms !== 'number' || isNaN(ms) || ms < 0) return '—'
    var s = Math.round(ms / 1000)
    if (s < 60) return s + 's'
    var m = Math.floor(s / 60)
    var rest = s % 60
    if (m < 60) return m + 'm' + (rest < 10 ? '0' : '') + rest + 's'
    var h = Math.floor(m / 60)
    return h + 'h' + (m % 60) + 'm'
  }

  function formatClock(ts) {
    if (typeof ts !== 'number' || ts <= 0) return '—'
    var d = new Date(ts)
    return d.toLocaleTimeString()
  }

  function verdictClass(verdict) {
    if (verdict === 'pass') return 'v-pass'
    if (verdict === 'fail') return 'v-fail'
    if (verdict === 'stale') return 'v-stale'
    if (verdict === 'unverified') return 'v-unverified'
    if (verdict === 'error') return 'v-error'
    return 'v-none'
  }

  /* 路由原因（狼群全自动挑工人）：让「为什么这轮是它」在面板上看得见。 */
  var ROUTE_TEXT = {
    rotation: '自动轮换',
    continuation: '续跑沿用',
    explicit: '配置指定',
    'only-available': '唯一可用',
  }

  function routeLabel(reason) {
    if (typeof reason !== 'string' || reason === '') return null
    if (ROUTE_TEXT[reason]) return { text: ROUTE_TEXT[reason], cls: 'r-auto' }
    var m = /^fallback\((.+)-unavailable\)$/.exec(reason)
    if (m) return { text: '回退（' + m[1] + ' 不可用）', cls: 'r-fallback' }
    return { text: reason, cls: 'r-auto' }
  }

  function stallStateOf(stall, windowMs) {
    if (!stall) {
      return { state: 'idle', text: '当前没有在跑的任务，停滞监控未采样' }
    }
    var windowText = formatDuration(windowMs || stall.window_ms || 0)
    if (stall.enabled !== true) {
      return { state: 'off', text: '监控未启用（存储根不可用，或窗口被设为 0）' }
    }
    if (stall.unavailable === true) {
      return { state: 'unknown', text: '暂时观测不到会话写入（采样 ' + (stall.heartbeats || 0) + ' 次）——不代表卡住' }
    }
    if (stall.warnings > 0) {
      return {
        state: 'warn',
        text: '疑似停滞，已报警 ' + stall.warnings + '/' + stall.max_warnings + ' 次 · 最长静默 '
          + formatDuration(stall.silent_ms) + ' · 窗口 ' + windowText + ' · 只报警，永不自动终止',
      }
    }
    if (stall.exhausted === true) {
      return {
        state: 'warn',
        text: '已报警完毕（不再打扰）· 最长静默 ' + formatDuration(stall.silent_ms) + ' · 窗口 ' + windowText,
      }
    }
    return {
      state: 'ok',
      text: '有进展 · 采样 ' + (stall.heartbeats || 0) + ' 次 · 最近静默 ' + formatDuration(stall.silent_ms) + ' · 窗口 ' + windowText,
    }
  }

  function renderTranscript(run) {
    var t = run.transcript
    var wrap = document.createElement('div')
    wrap.className = 'tr'

    var head = document.createElement('div')
    head.className = 'tr-head'
    var stepText = (run.step_index === null || run.step_index === undefined)
      ? ''
      : ' · 步 ' + run.step_index + (run.step_total ? '/' + run.step_total : '')
    head.textContent = '会话流水（只读尾部）' + stepText
    wrap.appendChild(head)

    if (!t || t.available !== true) {
      var miss = document.createElement('div')
      miss.className = 'tr-empty'
      miss.textContent = (t && t.reason) ? t.reason : '暂无可读流水'
      wrap.appendChild(miss)
      return wrap
    }

    var events = Array.isArray(t.events) ? t.events : []
    if (events.length === 0) {
      var none = document.createElement('div')
      none.className = 'tr-empty'
      none.textContent = '（流水里还没有可展示的事件）'
      wrap.appendChild(none)
      return wrap
    }

    var latest = events[events.length - 1]
    var block = document.createElement('pre')
    block.className = 'tr-latest'
    block.textContent = '[' + latest.kind + '] ' + (latest.text || '')
    wrap.appendChild(block)

    if (events.length > 1) {
      var details = document.createElement('details')
      details.className = 'tr-history'
      var summary = document.createElement('summary')
      summary.textContent = '更早 ' + (events.length - 1) + ' 条'
      details.appendChild(summary)
      for (var i = events.length - 2; i >= 0; i--) {
        var row = document.createElement('div')
        row.className = 'tr-event'
        var kind = document.createElement('span')
        kind.className = 'tr-kind'
        kind.textContent = events[i].kind + (events[i].at ? ' · ' + events[i].at : '')
        row.appendChild(kind)
        row.appendChild(document.createTextNode(events[i].text || ''))
        details.appendChild(row)
      }
      wrap.appendChild(details)
    }
    return wrap
  }

  function renderRun(run) {
    var card = document.createElement('div')
    card.className = 'run ' + (run.status === 'running' ? 'is-running' : 'is-idle')

    var head = document.createElement('div')
    head.className = 'run-head'

    var dot = document.createElement('span')
    dot.className = 'dot ' + run.status
    head.appendChild(dot)

    var id = document.createElement('span')
    id.className = 'task-id'
    id.textContent = run.task_id
    head.appendChild(id)

    var round = document.createElement('span')
    round.className = 'muted'
    round.textContent = '第 ' + (run.round || 1) + ' 轮'
    head.appendChild(round)

    if (run.status === 'running') {
      var live = document.createElement('span')
      live.className = 'tag running'
      live.textContent = '运行中'
      head.appendChild(live)
    } else {
      var verdict = document.createElement('span')
      verdict.className = 'tag ' + verdictClass(run.verdict)
      verdict.textContent = run.verdict || '未验收'
      head.appendChild(verdict)
      if (run.stop_reason) {
        var stop = document.createElement('span')
        stop.className = 'mono muted'
        stop.textContent = run.stop_reason
        head.appendChild(stop)
      }
    }

    var route = routeLabel(run.worker_reason)
    if (route) {
      var routeTag = document.createElement('span')
      routeTag.className = 'tag ' + route.cls
      routeTag.textContent = route.text
      head.appendChild(routeTag)
    }
    if (run.continued === true) {
      var cont = document.createElement('span')
      cont.className = 'tag r-auto'
      cont.textContent = '续跑'
      head.appendChild(cont)
    }
    card.appendChild(head)

    var meta = document.createElement('div')
    meta.className = 'run-meta'
    function pushMeta(text) {
      var s = document.createElement('span')
      s.textContent = text
      meta.appendChild(s)
    }
    if (run.status === 'running' && typeof run.elapsed_ms === 'number') {
      pushMeta('已跑 ' + formatDuration(run.elapsed_ms))
    }
    if (run.status !== 'running' && typeof run.finished_at === 'number') {
      pushMeta('结束于 ' + formatClock(run.finished_at))
    }
    if (typeof run.elapsed_ms === 'number') pushMeta('耗时 ' + formatDuration(run.elapsed_ms))
    if (typeof run.total_tokens === 'number' && run.total_tokens > 0) pushMeta('累计 ' + formatTokens(run.total_tokens) + ' tokens')
    if (typeof run.cache_read_tokens === 'number' && run.cache_read_tokens > 0) pushMeta('缓存读 ' + formatTokens(run.cache_read_tokens))
    if (typeof run.changed_file_count === 'number') pushMeta('改动 ' + run.changed_file_count + ' 文件')
    if (typeof run.stall_warnings === 'number' && run.stall_warnings > 0) pushMeta('停滞报警 ' + run.stall_warnings + ' 次')
    card.appendChild(meta)

    if (run.status === 'running' && run.stall) {
      var stall = stallStateOf(run.stall, null)
      var stallBox = document.createElement('div')
      stallBox.className = 'stall ' + stall.state
      stallBox.textContent = '⏳ ' + stall.text
      card.appendChild(stallBox)
    }

    card.appendChild(renderTranscript(run))
    return card
  }

  function renderWorker(worker) {
    var section = document.createElement('section')
    section.className = 'worker'

    var head = document.createElement('header')
    head.className = 'worker-head'

    var title = document.createElement('div')
    title.className = 'worker-title'
    var name = document.createElement('span')
    name.textContent = worker.label || worker.worker
    title.appendChild(name)
    var key = document.createElement('span')
    key.className = 'mono muted'
    key.textContent = worker.worker
    title.appendChild(key)
    head.appendChild(title)

    var badge = document.createElement('span')
    badge.className = 'tag ' + (worker.counts.running > 0 ? 'running' : 'idle')
    badge.textContent = worker.counts.running > 0 ? '运行中 ×' + worker.counts.running : '空闲'
    head.appendChild(badge)
    section.appendChild(head)

    var stats = document.createElement('div')
    stats.className = 'worker-stats'
    function pushStat(text, cls) {
      var s = document.createElement('span')
      s.className = 'stat ' + (cls || '')
      s.textContent = text
      stats.appendChild(s)
    }
    pushStat('台账任务 ' + worker.counts.ledger_total)
    pushStat('累计 ' + formatTokens(worker.tokens.total) + ' tokens')
    if (worker.tokens.cache_read > 0) pushStat('缓存读 ' + formatTokens(worker.tokens.cache_read) + ' tokens')
    if (worker.last_run && worker.last_run.verdict) {
      pushStat('最近 ' + worker.last_run.task_id + ' · ' + worker.last_run.verdict, verdictClass(worker.last_run.verdict))
    }
    if (worker.store_root) {
      var store = document.createElement('span')
      store.className = 'stat mono muted store'
      store.textContent = worker.store_root
      store.title = worker.store_root
      stats.appendChild(store)
    }
    section.appendChild(stats)

    var stall = stallStateOf(worker.stall, worker.stall_window_ms)
    var stallBox = document.createElement('div')
    stallBox.className = 'stall ' + stall.state
    stallBox.textContent = '⏳ 停滞监控（' + worker.worker + '）：' + stall.text
    section.appendChild(stallBox)

    var list = document.createElement('div')
    list.className = 'runs'
    var runs = (worker.running || []).concat(worker.idle || [])
    if (runs.length === 0) {
      var empty = document.createElement('div')
      empty.className = 'empty'
      empty.textContent = '这个工人还没有任何记录'
      list.appendChild(empty)
    } else {
      for (var i = 0; i < runs.length; i++) list.appendChild(renderRun(runs[i]))
    }
    section.appendChild(list)
    return section
  }

  function render(payload) {
    lastPayload = payload
    var root = el('workers')
    root.textContent = ''
    var workers = payload.workers || {}
    var order = Object.keys(workers)
    // 固定顺序：先 agy 后 claude，保证两个分区位置稳定，便于对比
    order.sort(function (a, b) {
      if (a === b) return 0
      if (a === 'agy') return -1
      if (b === 'agy') return 1
      return a < b ? -1 : 1
    })
    for (var i = 0; i < order.length; i++) {
      root.appendChild(renderWorker(workers[order[i]]))
    }
    el('updated').textContent = '更新于 ' + new Date(payload.generated_at || Date.now()).toLocaleTimeString()
    el('totals').textContent = '台账任务合计 ' + (payload.ledger_total || 0) + ' 个 · 本响应 ' + (payload.runs || []).length + ' 条运行'
  }

  function showError(error) {
    var box = el('error')
    box.textContent = '拉取实时状态失败：' + (error && error.message ? error.message : String(error))
    box.style.display = 'block'
  }

  function clearError() {
    var box = el('error')
    box.textContent = ''
    box.style.display = 'none'
  }

  function refresh() {
    if (paused) return
    fetch(LIVE_URL + location.search.replace(/^\?/, '?'), { headers: { accept: 'application/json' } })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status)
        return res.json()
      })
      .then(function (payload) {
        clearError()
        render(payload)
      })
      .catch(showError)
  }

  function schedule() {
    if (timer !== null) clearInterval(timer)
    timer = setInterval(refresh, refreshMs)
  }

  function boot() {
    el('refresh').addEventListener('click', refresh)
    el('pause').addEventListener('click', function () {
      paused = !paused
      el('pause').textContent = paused ? '继续' : '暂停'
      el('pause').classList.toggle('on', paused)
      if (!paused) refresh()
    })
    el('all').addEventListener('click', function (event) {
      event.preventDefault()
      fetch(LIVE_URL + '?limit=50' + (location.search ? '&' + location.search.slice(1) : ''))
        .then(function (res) { return res.json() })
        .then(function (payload) { render(payload); el('hint').textContent = '已请求全部（上限 50 条）' })
        .catch(showError)
    })
    refresh()
    schedule()
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot)
  else boot()
})()
