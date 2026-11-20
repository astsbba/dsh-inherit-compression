/* ═══════════════════════════════════════════════════════════════════════
 * dsh-inherit-compression · 继承功能（客户端半边）
 *
 * 这段代码不是一个独立模块——它被 build 脚本原样塞进 retrace 客户端 bundle
 * 的工厂作用域里（见 build-inherit-client.mjs）。所以：
 *   - `require` 就是加载器给的那个 require，React 照样能拿；
 *   - `apply` 是本包自己的激活函数，我们把它包一层，先让它跑完再挂我们的槽。
 *   web 的模块加载器一个文件只认一个模块，额外再写一个 load() 不会被激活，
 *   所以只能这样"缝"进同一个模块里。
 *
 * 铁律不变：这段代码里任何异常都不许外抛，抛了整条 client entry 判失败。
 * ═══════════════════════════════════════════════════════════════════════ */
;(function () {
  var API = '/dsh-inherit-compression/api'
  var BUILD = 'inherit-33'

  function report(phase, err) {
    try {
      var body = JSON.stringify({
        phase: String(phase),
        message: String((err && err.message) || err || 'ok'),
        stack: String((err && err.stack) || '').slice(0, 4000),
      })
      fetch(API + '/clienterror', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: body,
      }).catch(function () {})
    } catch (e) { /* 上报自己失败也只能算了 */ }
  }

  try {
    var React = require('react')
    var h = React.createElement

    /* ── 页面级共享状态：一个页面只轮询一次，所有按钮共用 ── */
    var subs = new Set()
    var view = { ok: false, roots: {} }
    var timer = null
    var appCtx = null

    function notify() {
      subs.forEach(function (fn) { try { fn() } catch (e) { /* 单个订阅崩了不影响别人 */ } })
    }

    function subscribe(fn) {
      subs.add(fn)
      return function () { try { subs.delete(fn) } catch (e) { /* 忽略 */ } }
    }

    function getJson(path) {
      return fetch(API + path, { headers: { 'cache-control': 'no-store' } }).then(function (r) { return r.json() })
    }

    function post(path, body) {
      return fetch(API + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
      }).then(function (r) {
        return r.json().catch(function () { return { ok: false, error: '响应不是 JSON' } })
      })
    }

    function refresh() {
      return getJson('/state').then(function (j) {
        var changed = JSON.stringify(j) !== JSON.stringify(view)
        view = j
        if (changed) notify()
        watchCompressHint(j)
        return j
      }).catch(function () { /* 宿主没起来就安静等着 */ })
    }

    function startPoll() {
      try {
        if (timer) return
        refresh()
        timer = setInterval(refresh, 3000)
      } catch (e) { report('poll', e) }
    }

    /* ── 配色：只用主题变量，取不到退回中性色 ── */
    var ACTIVE_COLOR = '#74d189'
    var ANCHOR_COLOR = '#e8a33d'
    var TAIL_COLOR = '#e0636b'
    var IDLE_COLOR = 'var(--dsw-alias-text-secondary, #8a8f98)'
    var MUTED = 'var(--dsw-alias-text-secondary, #8a8f98)'
    var BORDER = '1px solid var(--dsw-alias-border, rgba(127,127,127,0.28))'
    var FIELD_BG = 'var(--dsw-alias-bg-elevated, rgba(127,127,127,0.08))'

    /** 把输入框的值夹到区间内（非数字按最小值算，小数向下取整）。 */
    function clampNum(value, lo, hi) {
      var n = Number(value)
      if (!isFinite(n)) return lo
      return Math.min(hi, Math.max(lo, Math.floor(n)))
    }

    /* ═══ ① 消息行里的继承按钮（纯图标） ═══ */
    function InheritButton(props) {
      try {
        var sessionId = props && props.sessionId ? String(props.sessionId) : ''
        var messageId = props && props.messageId ? String(props.messageId) : ''

        var tickState = React.useState(0)
        var setTick = tickState[1]
        var busyState = React.useState(false)
        var busy = busyState[0]
        var setBusy = busyState[1]
        var hoverState = React.useState(false)
        var hover = hoverState[0]
        var setHover = hoverState[1]
        var pressState = React.useState(false)
        var pressed = pressState[0]
        var setPressed = pressState[1]
        var errState = React.useState('')
        var failure = errState[0]
        var setFailure = errState[1]

        React.useEffect(function () {
          return subscribe(function () { setTick(function (n) { return n + 1 }) })
        }, [])

        if (!sessionId) return null

        var roots = (view && view.roots) || {}
        var self = roots[sessionId]
        var inheritOn = !!(self && self.enabled)
        var anchoredHere = !!(inheritOn && self.anchorMessageId && self.anchorMessageId === messageId)
        // 位置由宿主判：它把「锚点之后有哪些消息」直接算成 id 列表发过来，客户端只查表。
        var afterIdsKnown = !!(inheritOn && self && Array.isArray(self.afterIds))
        var afterIds = afterIdsKnown ? self.afterIds : []
        var afterAnchor = !!(inheritOn && !anchoredHere && afterIds.indexOf(messageId) >= 0)
        // d 类：最新那条助手回复。它是"现在就收一次"的按钮，不是开关。
        var tailId = inheritOn && self && typeof self.tailMessageId === 'string' ? self.tailMessageId : ''
        var isTail = !!(inheritOn && !anchoredHere && tailId !== '' && tailId === messageId)

        // 锚点之前的消息：按钮整条消失。只有宿主真的给了清单才敢藏——
        // 否则清单缺席会把锚点之后的一起藏掉，界面上看就是"按钮凭空消失"。
        if (inheritOn && !anchoredHere && afterIdsKnown && !afterAnchor) return null

        // 这一趟正在压缩/撤回：除了正在忙的那颗（本实例 busy=true），其余全藏起来，
        // 免得有人半路点取消，把一趟压到一半的操作打断（宿主那边也会拒绝取消）。
        var working = !!(self && self.working)
        if (working && !busy) return null

        var inheriting = anchoredHere || afterAnchor
        var tone = anchoredHere ? ANCHOR_COLOR : isTail ? TAIL_COLOR : afterAnchor ? ACTIVE_COLOR : IDLE_COLOR
        var toneBg = anchoredHere
          ? 'rgba(232,163,61,0.16)'
          : isTail
            ? 'rgba(224,99,107,0.16)'
            : afterAnchor
              ? 'rgba(116,209,137,0.16)'
              : 'transparent'

        var onClick = function (event) {
          try { event.preventDefault(); event.stopPropagation() } catch (e) { /* 忽略 */ }
          if (busy) return
          setBusy(true)
          setFailure('')
          var job = !inheritOn
            ? post('/attach', { sessionId: sessionId, messageId: messageId })
            : isTail
              ? post('/trim', { sessionId: sessionId })
              : post('/detach', { sessionId: sessionId })
          job.then(function (out) {
            setBusy(false)
            if (!out || out.ok !== true) setFailure(String((out && out.error) || '操作失败'))
            return refresh()
          }).catch(function (e) { setBusy(false); setFailure(String((e && e.message) || e)) })
        }

        return h('span', { style: { display: 'inline-flex', alignItems: 'center' } }, [
          h('button', {
            key: 'btn',
            type: 'button',
            onClick: onClick,
            disabled: busy,
            'aria-pressed': inheriting,
            'aria-label': anchoredHere ? '锚点' : afterAnchor ? '继承中' : '继承',
            title: busy
              ? '正在压缩，模型回一次大概要十几二十秒，这期间别点别的'
              : anchoredHere
                ? '这里是锚点：再点一下取消继承，这条会话就不再被接管'
                : isTail
                  ? '最新一条回复：点一下立刻把锚点之后整段收一次——不超过条数原样搬，超过就压成摘要再撤回'
                  : afterAnchor
                    ? '锚点之后的部分：到线时这一段会被压进记忆并从对话里抽走；点一下也能取消继承'
                    : '继承：在这条消息上立锚点，上下文到线时压缩后面的对话',
            onMouseEnter: function () { setHover(true) },
            onMouseLeave: function () { setHover(false); setPressed(false) },
            onMouseDown: function () { setPressed(true) },
            onMouseUp: function () { setPressed(false) },
            onFocus: function () { setHover(true) },
            onBlur: function () { setHover(false) },
            style: {
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 26,
              height: 26,
              padding: 0,
              border: 'none',
              borderRadius: 8,
              background: pressed
                ? 'var(--dsw-alias-bg-active, rgba(127,127,127,0.24))'
                : hover
                  ? 'var(--dsw-alias-bg-hover, rgba(127,127,127,0.16))'
                  : toneBg,
              color: inheriting
                ? tone
                : hover
                  ? 'var(--dsw-alias-text-primary, #d8dbe0)'
                  : IDLE_COLOR,
              cursor: busy ? 'default' : 'pointer',
              opacity: busy ? 0.85 : 1,
              transition: 'background 120ms ease, color 120ms ease',
            },
          }, busy
            // 压缩要等模型回话（十几二十秒），得让人看见它在干活，不然就像卡死。
            ? h('span', {
              key: 'busy',
              style: { fontSize: 12, lineHeight: '14px', letterSpacing: 1, fontWeight: 600 },
            }, '···')
            : h('svg', {
              width: 14,
              height: 14,
              viewBox: '0 0 24 24',
              fill: 'none',
              stroke: 'currentColor',
              strokeWidth: 2,
              strokeLinecap: 'round',
              strokeLinejoin: 'round',
              'aria-hidden': true,
            }, inheriting
              ? [h('rect', { key: 'd', x: 7, y: 7, width: 10, height: 10, rx: 2.5, fill: 'none', stroke: 'currentColor', strokeWidth: 2, transform: 'rotate(45 12 12)' })]
              : [h('circle', { key: 'c', cx: 12, cy: 12, r: 7, fill: 'none', stroke: 'currentColor', strokeWidth: 2 })])),
          failure
            ? h('span', { key: 'err', style: { fontSize: 11, color: '#e06c75', marginLeft: 6 } }, failure)
            : null,
        ])
      } catch (e) {
        report('render:button', e)
        return null
      }
    }

    /* ═══ ② 设置页：选模型、设触发线、改压缩提示词、看日志 ═══ */
    var labelStyle = { fontSize: 12, color: MUTED, lineHeight: '18px' }
    var hintStyle = { fontSize: 12, color: MUTED, lineHeight: '18px' }
    var fieldStyle = {
      width: '100%',
      boxSizing: 'border-box',
      padding: '7px 9px',
      borderRadius: 8,
      border: BORDER,
      background: FIELD_BG,
      color: 'inherit',
      font: 'inherit',
      fontSize: 13,
      lineHeight: '20px',
      outline: 'none',
    }

    function Row(label, hint, node) {
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } }, [
        h('div', { key: 'l', style: labelStyle }, label),
        hint ? h('div', { key: 'h', style: hintStyle }, hint) : null,
        h('div', { key: 'n' }, node),
      ])
    }

    function SettingsPage() {
      try {
        var formState = React.useState({ triggerTokens: 600000, provider: '', model: '', prompt: '', injectPrompt: '', maxBlockChars: 4000, recentRounds: 5, recentCharsPerRound: 500 })
        var form = formState[0]
        var setForm = formState[1]
        var groupsState = React.useState([])
        var groups = groupsState[0]
        var setGroups = groupsState[1]
        var statusState = React.useState('')
        var status = statusState[0]
        var setStatus = statusState[1]
        var busyState = React.useState(false)
        var busy = busyState[0]
        var setBusy = busyState[1]

        var logState = React.useState({ text: '', path: '' })
        var logInfo = logState[0]
        var setLogInfo = logState[1]

        var loadLog = function () {
          getJson('/log').then(function (out) {
            if (out && out.ok) {
              setLogInfo({ text: String(out.text || ''), path: String(out.path || '') })
            } else {
              setLogInfo({ text: '读日志失败：' + String((out && out.error) || '未知原因'), path: '' })
            }
          }).catch(function (e) {
            setLogInfo({ text: '读日志失败：' + String((e && e.message) || e), path: '' })
          })
        }

        React.useEffect(function () {
          var live = true
          getJson('/settings').then(function (a) {
            if (live && a && a.settings) setForm(a.settings)
          }).catch(function (e) {
            if (live) setStatus('读设置失败：' + String((e && e.message) || e))
          })
          getJson('/models').then(function (b) {
            if (live) setGroups(Array.isArray(b && b.groups) ? b.groups : [])
          }).catch(function () { /* 没有模型清单就只显示输入框 */ })
          loadLog()
          return function () { live = false }
        }, [])

        var set = function (patch) {
          setForm(function (f) {
            var next = {}
            for (var k in f) next[k] = f[k]
            for (var k2 in patch) next[k2] = patch[k2]
            return next
          })
        }

        var save = function () {
          if (busy) return
          setBusy(true)
          setStatus('')
          post('/settings', {
            triggerTokens: Number(form.triggerTokens),
            provider: form.provider || '',
            model: form.model || '',
            prompt: form.prompt || '',
            injectPrompt: form.injectPrompt || '',
            maxBlockChars: Number(form.maxBlockChars),
            recentRounds: Number(form.recentRounds),
            recentCharsPerRound: Number(form.recentCharsPerRound),
          }).then(function (out) {
            setBusy(false)
            if (out && out.ok) {
              setForm(out.settings)
              setStatus('已保存')
              refresh()
            } else {
              setStatus('保存失败：' + String((out && out.error) || '未知原因'))
            }
          }).catch(function (e) {
            setBusy(false)
            setStatus('保存失败：' + String((e && e.message) || e))
          })
        }

        var currentGroup = null
        for (var i = 0; i < groups.length; i += 1) {
          if (groups[i] && groups[i].id === form.provider) { currentGroup = groups[i]; break }
        }
        var modelOptions = currentGroup && Array.isArray(currentGroup.models) ? currentGroup.models : []

        var providerSelect = h('select', {
          value: form.provider || '',
          onChange: function (e) { set({ provider: e.target.value, model: '' }) },
          style: fieldStyle,
        }, [h('option', { key: '__auto', value: '' }, '跟随会话当前模型')].concat(groups.map(function (g) {
          return h('option', { key: g.id, value: g.id }, g.name || g.id)
        })))

        var modelSelect = h('select', {
          value: form.model || '',
          onChange: function (e) { set({ model: e.target.value }) },
          disabled: !form.provider,
          style: fieldStyle,
        }, [h('option', { key: '__none', value: '' }, form.provider ? '选一个模型' : '先选提供方')].concat(modelOptions.map(function (m) {
          return h('option', { key: m.id, value: m.id }, m.name || m.id)
        })))

        // 日志面板：最新的排最上面（文件本身是追加写，越往后越新）
        var logLines = String(logInfo.text || '').split('\n').filter(function (line) { return line.trim() !== '' })
        var logText = logLines.slice().reverse().join('\n')

        return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 18, maxWidth: 560, padding: '4px 0' } }, [
          h('div', { key: 'title', style: { fontSize: 14, lineHeight: '20px' } }, '会话继承'),
          h('div', { key: 'desc', style: hintStyle }, '在消息上点「继承」立锚点；上下文到线时，只把锚点之后新增的部分压成一块记忆，撤回后面的对话，把它交给下一条消息。'),
          h('div', { key: 'model' }, Row(
            '总结模型',
            '压缩用的模型。留空就跟随当前会话正在用的那个。',
            h('div', { style: { display: 'flex', gap: 8 } }, [providerSelect, modelSelect])
          )),
          h('div', { key: 'line' }, Row(
            '上下文上限（token）',
            '到这个量就触发压缩。这个数就是实际判断用的那个值，改完保存立刻生效。',
            h('input', {
              type: 'number',
              step: 1000,
              min: 1000,
              value: form.triggerTokens == null ? '' : form.triggerTokens,
              onChange: function (e) { set({ triggerTokens: e.target.value === '' ? '' : Number(e.target.value) }) },
              style: fieldStyle,
            })
          )),
          h('div', { key: 'prompt' }, Row(
            '压缩提示词',
            '建议保住称呼、语气、偏好、已经定下的事实和没做完的事。留空默认使用提示词。',
            h('textarea', {
              value: form.prompt || '',
              onChange: function (e) { set({ prompt: e.target.value }) },
              rows: 8,
              spellCheck: false,
              style: {
                width: '100%',
                boxSizing: 'border-box',
                padding: '7px 9px',
                borderRadius: 8,
                border: BORDER,
                background: FIELD_BG,
                color: 'inherit',
                fontFamily: 'inherit',
                fontSize: 13,
                lineHeight: '20px',
                outline: 'none',
                resize: 'vertical',
                minHeight: 120,
              },
            })
          )),
          h('div', { key: 'inject' }, Row(
            '注入提示词',
            '压完之后贴在「近期对话」块末尾的那句指令，决定模型怎么用这段原文。留空使用默认提示词。',
            h('textarea', {
              value: form.injectPrompt || '',
              onChange: function (e) { set({ injectPrompt: e.target.value }) },
              rows: 6,
              spellCheck: false,
              style: {
                width: '100%',
                boxSizing: 'border-box',
                padding: '7px 9px',
                borderRadius: 8,
                border: BORDER,
                background: FIELD_BG,
                color: 'inherit',
                fontFamily: 'inherit',
                fontSize: 13,
                lineHeight: '20px',
                outline: 'none',
                resize: 'vertical',
                minHeight: 96,
              },
            })
          )),
          h('div', { key: 'limits' }, Row(
            '篇幅与取材',
            '压缩后正文最多多少字；每次压完，记忆后面再带几轮原文当近期对话，每轮最多带多少字。',
            h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } }, [
              h('div', { key: 'row1', style: { display: 'flex', gap: 10 } }, [
                h('div', { key: 'a', style: { flex: 1, display: 'flex', flexDirection: 'column', gap: 4 } }, [
                  h('div', { key: 'l', style: hintStyle }, '压缩上限字数'),
                  h('input', {
                    key: 'i',
                    type: 'number',
                    step: 100,
                    min: 500,
                    max: 100000,
                    value: form.maxBlockChars == null ? '' : form.maxBlockChars,
                    onChange: function (e) { set({ maxBlockChars: e.target.value === '' ? '' : Number(e.target.value) }) },
                    onBlur: function (e) { set({ maxBlockChars: clampNum(e.target.value, 500, 100000) }) },
                    style: fieldStyle,
                  }),
                ]),
                h('div', { key: 'b', style: { flex: 1, display: 'flex', flexDirection: 'column', gap: 4 } }, [
                  h('div', { key: 'l', style: hintStyle }, '近期对话条数'),
                  h('input', {
                    key: 'i',
                    type: 'number',
                    step: 1,
                    min: 0,
                    max: 300,
                    value: form.recentRounds == null ? '' : form.recentRounds,
                    onChange: function (e) { set({ recentRounds: e.target.value === '' ? '' : Number(e.target.value) }) },
                    onBlur: function (e) { set({ recentRounds: clampNum(e.target.value, 0, 300) }) },
                    style: fieldStyle,
                  }),
                ]),
              ]),
              h('div', { key: 'row2', style: { display: 'flex', gap: 10 } }, [
                h('div', { key: 'c', style: { flex: 1, display: 'flex', flexDirection: 'column', gap: 4 } }, [
                  h('div', { key: 'l', style: hintStyle }, '每轮最多注入字数'),
                  h('input', {
                    key: 'i',
                    type: 'number',
                    step: 50,
                    min: 50,
                    max: 5000,
                    value: form.recentCharsPerRound == null ? '' : form.recentCharsPerRound,
                    onChange: function (e) { set({ recentCharsPerRound: e.target.value === '' ? '' : Number(e.target.value) }) },
                    onBlur: function (e) { set({ recentCharsPerRound: clampNum(e.target.value, 50, 5000) }) },
                    style: fieldStyle,
                  }),
                  h('div', { key: 'h', style: hintStyle }, '每一轮原文最多带多少字，默认 500；条数×这个值就是注入总量上限。'),
                ]),
                h('div', { key: 'd', style: { flex: 1 } }),
              ]),
            ])
          )),
          h('div', { key: 'log' }, Row(
            '运行日志',
            '最近 200 行。出问题把这段发我，或者按路径自己打开那个文件。',
            h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } }, [
              h('pre', {
                key: 't',
                style: {
                  margin: 0,
                  maxHeight: 220,
                  overflow: 'auto',
                  padding: '8px 10px',
                  borderRadius: 8,
                  border: BORDER,
                  background: FIELD_BG,
                  fontFamily: 'ui-monospace, Menlo, Consolas, monospace',
                  fontSize: 11,
                  lineHeight: '16px',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-all',
                },
              }, logText || '（还没有日志）'),
              h('div', { key: 'b', style: { display: 'flex', alignItems: 'center', gap: 8 } }, [
                h('button', {
                  key: 'r',
                  type: 'button',
                  onClick: loadLog,
                  style: {
                    padding: '5px 12px',
                    borderRadius: 8,
                    border: BORDER,
                    background: 'transparent',
                    color: 'inherit',
                    font: 'inherit',
                    fontSize: 12,
                    cursor: 'pointer',
                  },
                }, '刷新'),
                h('span', { key: 'p', style: { fontSize: 11, color: MUTED, wordBreak: 'break-all' } }, logInfo.path || ''),
              ]),
            ])
          )),
          h('div', { key: 'actions', style: { display: 'flex', alignItems: 'center', gap: 12 } }, [
            h('button', {
              key: 'save',
              type: 'button',
              onClick: save,
              disabled: busy,
              style: {
                padding: '7px 16px',
                borderRadius: 8,
                border: 'none',
                background: 'var(--dsw-alias-accent, #4d6bfe)',
                color: '#fff',
                font: 'inherit',
                fontSize: 13,
                cursor: busy ? 'default' : 'pointer',
                opacity: busy ? 0.6 : 1,
              },
            }, busy ? '保存中…' : '保存'),
            status ? h('span', { key: 's', style: hintStyle }, status) : null,
          ]),
        ])
      } catch (e) {
        report('render:settings', e)
        return null
      }
    }

    /* ── 「压缩总结已触发」提示：只在真的调了模型压缩之后弹一条，5 秒自己淡出 ── */
    var compressSeen = {}

    function showHintToast(text) {
      try {
        if (typeof document === 'undefined' || !document.body) return
        var el = document.createElement('div')
        el.textContent = text
        el.style.cssText = 'position:fixed;left:50%;bottom:48px;transform:translateX(-50%);z-index:9999;'
          + 'padding:8px 14px;border-radius:10px;background:rgba(20,20,22,0.88);color:#f2f2f2;'
          + 'font-size:13px;line-height:20px;box-shadow:0 6px 20px rgba(0,0,0,0.25);'
          + 'pointer-events:none;opacity:0;transition:opacity 200ms ease;'
        document.body.appendChild(el)
        requestAnimationFrame(function () { el.style.opacity = '1' })
        setTimeout(function () {
          try {
            el.style.opacity = '0'
            setTimeout(function () { try { el.remove() } catch (e) { /* 忽略 */ } }, 250)
          } catch (e) { /* 忽略 */ }
        }, 5000)
      } catch (e) { report('toast', e) }
    }

    /** 比对 /state 里的「上次真压缩时间」，变新了就弹一次。 */
    function watchCompressHint(snapshot) {
      try {
        var roots = (snapshot && snapshot.roots) || {}
        for (var id in roots) {
          if (!Object.prototype.hasOwnProperty.call(roots, id)) continue
          var at = Number(roots[id].lastModelCompressAt || 0)
          if (!(at > 0)) continue
          if (compressSeen[id] !== undefined && at > compressSeen[id]) {
            showHintToast('压缩总结已触发，回退到锚点处，下一轮消息注入记忆内容。')
          }
          compressSeen[id] = at
        }
      } catch (e) { report('hint:watch', e) }
    }

    /* ── 编辑按钮的显隐：只有最新一条常显，旧的靠近/聚焦才浮现 ── */
    function installEditAffordance() {
      try {
        if (typeof document === 'undefined' || !document.head) return function () {}
        var STYLE_FLAG = 'dsh-kk-edit-affordance'
        if (!document.querySelector('style[data-kk="' + STYLE_FLAG + '"]')) {
          var tag = document.createElement('style')
          tag.setAttribute('data-kk', STYLE_FLAG)
          tag.textContent = '.dsh-rt-user-actions{opacity:0;pointer-events:none;transition:opacity 140ms ease}'
            + '.dsh-rt-user-row:hover .dsh-rt-user-actions,'
            + '.dsh-rt-user-row:focus-within .dsh-rt-user-actions,'
            + '[data-kk-edit-last="1"] .dsh-rt-user-actions{opacity:1;pointer-events:auto}'
            // 编辑键对齐官方原生图标键：padding 6px + 图标 15px、圆角 6、透明底、hover 才浮背景
            + '.dsh-rt-user-actions .dsh-rt-user-action[data-op="edit"]{'
            + 'box-sizing:content-box;height:auto;line-height:1;padding:6px;border:none;border-radius:6px;'
            + 'background:transparent;color:var(--dsw-alias-label-tertiary,inherit);'
            + 'display:inline-flex;align-items:center;justify-content:center;cursor:pointer}'
            + '.dsh-rt-user-actions .dsh-rt-user-action[data-op="edit"]:hover{'
            + 'background:var(--dsw-alias-bg-hover, rgba(127,127,127,0.16))}'
            + '.dsh-rt-user-actions .dsh-rt-user-action[data-op="edit"] svg{'
            + 'display:block;opacity:.8;'
            + 'width:calc(15px + var(--dsh-content-font-delta,0px));'
            + 'height:calc(15px + var(--dsh-content-font-delta,0px))}'
            // 编辑重发面板：去掉外框、整体灰白调、两个方角矩形按钮，不要蓝色
            + '.dsh-rt-editor{border:none!important;background:transparent!important;'
            + 'padding:0!important;border-radius:0!important;gap:8px!important}'
            + '.dsh-rt-textarea{border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.28))!important;'
            + 'background:transparent!important;border-radius:6px!important;box-shadow:none!important;'
            // 不再让人手拉大小：固定高，内容超了就框内滚动
            + 'resize:none!important;height:84px!important;max-height:84px!important;overflow-y:auto!important}'
            + '.dsh-rt-textarea:focus{border-color:var(--dsw-alias-border-l3,rgba(127,127,127,.45))!important;'
            + 'box-shadow:none!important}'
            + '.dsh-rt-editor-buttons{gap:8px!important}'
            + '.dsh-rt-editor-send,.dsh-rt-editor-cancel{border-radius:4px!important;'
            + 'font-size:13px!important;line-height:20px!important;padding:5px 14px!important;'
            + 'box-shadow:none!important;transition:background 120ms ease,color 120ms ease}'
            + '.dsh-rt-editor-send{background:var(--dsw-alias-bg-elevated,rgba(127,127,127,.14))!important;'
            + 'color:var(--dsw-alias-text-primary,inherit)!important;'
            + 'border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.28))!important}'
            + '.dsh-rt-editor-send:hover:not(:disabled){'
            + 'background:var(--dsw-alias-bg-hover,rgba(127,127,127,.22))!important}'
            + '.dsh-rt-editor-cancel{background:transparent!important;'
            + 'color:var(--dsw-alias-text-secondary,inherit)!important;'
            + 'border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.28))!important}'
            + '.dsh-rt-editor-cancel:hover:not(:disabled){'
            + 'background:var(--dsw-alias-bg-hover,rgba(127,127,127,.16))!important}'
          document.head.appendChild(tag)
        }
        var timer = setInterval(function () {
          try {
            var rows = document.querySelectorAll('.dsh-rt-user-row')
            for (var i = 0; i < rows.length; i += 1) rows[i].removeAttribute('data-kk-edit-last')
            var last = rows.length > 0 ? rows[rows.length - 1] : null
            if (last) last.setAttribute('data-kk-edit-last', '1')
          } catch (e) { /* 一轮扫不到就算了 */ }
        }, 600)
        return function () {
          try { clearInterval(timer) } catch (e) { /* 忽略 */ }
          try {
            var stale = document.querySelector('style[data-kk="' + STYLE_FLAG + '"]')
            if (stale) stale.remove()
          } catch (e) { /* 忽略 */ }
        }
      } catch (e) {
        report('edit:affordance', e)
        return function () {}
      }
    }

    /* ── 压缩后残留的轮内行：白名单几类，出现就整行收掉 ──
     * 这些行来自 turn/end、llm/retry 这类轮内事件，不是对话面节点，官方那套区间
     * 替换管不到；压缩撤走整段之后它们会孤零零挂在场上，越攒越多。
     * 做法：不认类名（试过，全落空），直接走文本节点 —— 找到那句话的最小容器，
     * 再爬到「只装着这句话」的最大祖先，连整行一起 display:none。 */
    function installRetryNoticeHider() {
      try {
        if (typeof document === 'undefined' || !document.body) return function () {}
        // 文案取自宿主词表（message.turnProcess.* / message.retry.*）：
        //   已完成 / 已完成，用时 … / 处理失败 / 已重试模型请求 / 正在重试模型请求 /
        //   等待重试模型请求 / 模型请求重试已取消（后面可能跟「（1/3） · 5s」）
        // 「处理失败」原本漏了：模型调用失败之后又触发压缩，那行会一直挂在那儿。
        var PATTERN = /^(已重试模型请求|正在重试模型请求|等待重试模型请求|模型请求重试已取消|处理失败|已完成(，用时|$|：|\s)|Completed in)/
        var MARK = 'data-kk-row-hidden'
        var lastLogged = ''

        function scan() {
          try {
            var roots = (view && view.roots) || {}
            var active = false
            for (var id in roots) {
              if (!Object.prototype.hasOwnProperty.call(roots, id)) continue
              // 只要这条会话压过（哪怕已经冻结），残留的行也该收拾
              if (roots[id] && Number(roots[id].compressions) > 0) { active = true; break }
            }
            if (!active) return
            var markers = document.querySelectorAll('.dsh-rt-marker-block')
            if (markers.length === 0) return
            // 只收拾「记忆块上面」的残行：那一段是被撤回的旧轮次留下的。
            // 记忆块下面属于新一轮（包括刚聊完这一轮的「已完成，用时」「思考分析」），
            // 一律不碰——之前不分位置地收，把正常信息也吞了，这是病根。
            var lastMarker = markers[markers.length - 1]
            var FOLLOWING = (typeof Node !== 'undefined' && Node.DOCUMENT_POSITION_FOLLOWING) || 4

            var targets = []
            if (typeof document.createTreeWalker === 'function') {
              var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null)
              var node = walker.nextNode()
              while (node) {
                var raw = String(node.nodeValue || '').trim()
                if (raw !== '' && raw.length <= 60 && PATTERN.test(raw)) targets.push(node)
                node = walker.nextNode()
              }
            }

            var hidden = 0
            for (var t = 0; t < targets.length; t += 1) {
              var el = targets[t].parentElement
              if (!el) continue
              // 往上爬：父容器里还只有这句短话就继续往上，正好停在「这一整行」上
              for (var up = 0; up < 6 && el.parentElement; up += 1) {
                var pt = ''
                try { pt = String(el.parentElement.textContent || '').trim() } catch (e) { pt = '' }
                if (pt === '' || pt.length > 60) break
                el = el.parentElement
              }
              if (el.contains(lastMarker)) continue
              // 在记忆块下面（属于新轮次）→ 跳过
              if (lastMarker.compareDocumentPosition(el) & FOLLOWING) continue
              if (el.getAttribute(MARK) === '1') continue
              el.setAttribute(MARK, '1')
              try { el.style.setProperty('display', 'none', 'important') } catch (e) { /* 忽略 */ }
              hidden += 1
            }
            if (hidden > 0 && String(hidden) !== lastLogged) {
              lastLogged = String(hidden)
              report('row-clean', new Error('hidden=' + hidden))
            }
          } catch (e) { /* 一轮扫不到就算了 */ }
        }

        // 定时器兜底 + 变更观察：打开会话时就地扫一次，避免「先闪一下再消失」
        var timer = setInterval(scan, 1200)
        var observer = null
        var pending = 0
        try {
          observer = new MutationObserver(function () {
            if (pending) return
            pending = setTimeout(function () { pending = 0; scan() }, 80)
          })
          observer.observe(document.body, { childList: true, subtree: true })
        } catch (e) { /* 观察者不可用就纯靠定时器 */ }
        scan()
        return function () {
          try { clearInterval(timer) } catch (e) { /* 忽略 */ }
          try { if (pending) clearTimeout(pending) } catch (e) { /* 忽略 */ }
          try { if (observer) observer.disconnect() } catch (e) { /* 忽略 */ }
        }
      } catch (e) {
        report('retry:hider', e)
        return function () {}
      }
    }

    /* ═══ 挂载：等 retrace 自己的 apply 跑完，再往槽里塞我们的两件东西 ═══ */
    function mountInherit(ctx) {
      try { appCtx = ctx } catch (e) { report('ctx', e) }

      try {
        startPoll()
        if (typeof ctx.effect === 'function') {
          ctx.effect(function () {
            startPoll()
            return function () {
              try { if (timer) { clearInterval(timer); timer = null } } catch (e) { /* 忽略 */ }
            }
          })
        }
      } catch (e) { report('poll', e) }

      try {
        var offEdit = installEditAffordance()
        if (typeof ctx.effect === 'function') ctx.effect(function () { return offEdit })
      } catch (e) { report('edit:mount', e) }

      try {
        var offRetry = installRetryNoticeHider()
        if (typeof ctx.effect === 'function') ctx.effect(function () { return offRetry })
      } catch (e) { report('retry:mount', e) }

      try {
        var mountButton = function () {
          return ctx.slots.inject('conversation.chat.assistant-actions', function () {
            return ctx.slots.register({
              name: 'conversation.chat.assistant-actions',
              id: 'inherit-compression',
              order: 15,
              label: '继承',
            }, InheritButton)
          })
        }
        if (typeof ctx.effect === 'function') ctx.effect(mountButton)
        else mountButton()
      } catch (e) { report('slot:button', e) }

      try {
        var mountSection = function () {
          return ctx.slots.inject('settings.section', function () {
            return ctx.slots.register({
              name: 'settings.section',
              id: 'inherit-compression',
              order: 48,
              label: '继承',
            }, SettingsPage)
          })
        }
        if (typeof ctx.effect === 'function') ctx.effect(mountSection)
        else mountSection()
      } catch (e) { report('slot:settings', e) }

      report('mount-ok ' + BUILD)
    }

    /* ── 包住本包已有的 apply ── */
    try {
      var originalApply = apply
      apply = function (ctx, config) {
        var out = originalApply.call(this, ctx, config)
        try { mountInherit(ctx) } catch (e) { report('mount', e) }
        return out
      }
    } catch (e) {
      report('wrap:apply', e)
    }
  } catch (e) {
    report('factory', e)
  }
})()
