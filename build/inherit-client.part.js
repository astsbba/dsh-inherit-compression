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
    // 当前会话 id（消息上的按钮顺手记下）：跳锚点按钮拿不到 props 时用它兜底。
    var lastSessionId = ''

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

    /* ═══ ① 跳回锚点按钮（输入框上方那颗方形按钮） ═══
     * 为什么要有它：被遮蔽的消息在日志里仍是普通消息，官方翻页照数不误，一页里大半是空壳，
     * 「加载更多」要点很多次才走到锚点之前。所以给一颗自己的按钮：点一下直接跳到锚点那条消息，
     * 中间的空白页由官方 loadThrough 在内部翻过去。挂载点用 composer 的 overlay 槽，
     * 也就是输入框那张卡片里，绝对定位浮到它上方右侧——和你画的位置一致。
     */
    var anchorJumpCtx = null

    function AnchorJumpButton(props) {
      try {
        var sessionId = String((props && props.sessionId) || lastSessionId || '')
        var useChat = props && props.useChat
        var nodes = null
        try {
          if (typeof useChat === 'function') nodes = useChat(function (s) { return s && s.nodes })
        } catch (e) { nodes = null }
        var nodesRef = React.useRef(nodes)
        nodesRef.current = nodes

        var hoverState = React.useState(false)
        var hover = hoverState[0]
        var setHover = hoverState[1]
        var busyState = React.useState(false)
        var busy = busyState[0]
        var setBusy = busyState[1]
        var tickPair = React.useState(0)
        var setTick = tickPair[1]

        React.useEffect(function () { return subscribe(function () { setTick(function (n) { return n + 1 }) }) }, [])

        var root = sessionId && view && view.roots ? view.roots[sessionId] : null
        var anchorSeq = root && Number.isFinite(Number(root.anchorSeq)) ? Number(root.anchorSeq) : -1
        var anchorTurn = root && Number.isSafeInteger(Number(root.anchorTurn)) ? Number(root.anchorTurn) : -1
        if (!(anchorSeq > 0)) return null

        var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms) }) }

        // 主判据：聊天气泡上带着 data-chat-turn（第几轮），锚点属于哪一轮宿主已经算好，
        // 直接按"这一轮的用户消息"去找那一行，比按内部 key 反查稳。
        var findRowByTurn = function () {
          if (!(anchorTurn > 0)) return null
          try {
            var exact = document.querySelector('[data-chat-flow-kind="user"][data-chat-turn="' + anchorTurn + '"]')
            if (exact) return exact
            var any = document.querySelectorAll('[data-chat-turn="' + anchorTurn + '"]')
            return any.length > 0 ? any[0] : null
          } catch (e) { return null }
        }

        // 备用判据：按节点 key 找（老会话可能没记下轮号）。
        var findRowByKey = function () {
          try {
            var table = nodesRef.current
            if (!table || typeof keyOfSeqIn !== 'function') return null
            var key = keyOfSeqIn(table, anchorSeq)
            if (key === null || key === undefined) return null
            var k = JSON.stringify(key)
            return document.querySelector('[data-chat-anchor-key=' + k + '],[data-chat-flow-key=' + k + '],[data-chat-node-key=' + k + ']')
          } catch (e) { return null }
        }

        var scrollToRow = function (el) {
          try { el.scrollIntoView({ behavior: 'smooth', block: 'center' }) } catch (e) { try { el.scrollIntoView() } catch (e2) {} }
          try {
            el.animate(
              [{ backgroundColor: 'rgba(77,107,254,0.16)' }, { backgroundColor: 'transparent' }],
              { duration: 1300, easing: 'ease-out' },
            )
          } catch (e) { /* 高亮失败不影响滚动 */ }
        }

        var storeOf = function () {
          try {
            var svc = anchorJumpCtx && anchorJumpCtx.get ? anchorJumpCtx.get('sessions') : null
            var bound = svc && typeof svc.binding === 'function' ? svc.binding(sessionId) : null
            return bound && bound.session ? bound.session : null
          } catch (e) { return null }
        }

        var jumpToAnchorRow = function () {
          var store = storeOf()
          var paged = false
          var attempt = 0
          var step = function () {
            var el = findRowByTurn() || findRowByKey()
            if (el) { scrollToRow(el); return Promise.resolve(true) }
            if (attempt >= 30) return Promise.resolve(false)
            attempt += 1
            if (!paged && attempt >= 2 && store && typeof store.loadThrough === 'function') {
              paged = true
              return Promise.resolve(store.loadThrough(anchorSeq))
                .catch(function () { return null })
                .then(function () { return sleep(120) })
                .then(step)
            }
            return sleep(140).then(step)
          }
          return step()
        }

        var onClick = function (event) {
          try { event.preventDefault(); event.stopPropagation() } catch (e) {}
          if (busy) return
          setBusy(true)
          // 跳转期间先让扫描安静下来，落地后再补一次
          try { rowQuietUntil = Date.now() + 1500 } catch (e) {}
          try { if (typeof switchToViewTab === 'function') switchToViewTab('chat') } catch (e) {}
          var finish = function () {
            setBusy(false)
            try { if (typeof rowKick === 'function') rowKick() } catch (e) {}
          }
          Promise.resolve(jumpToAnchorRow()).then(finish, function (e) { report('anchorjump:run', e); finish() })
          setTimeout(finish, 15000)
        }

        return React.createElement('button', {
          type: 'button',
          onClick: onClick,
          disabled: busy,
          title: busy ? '正在跳到锚点…' : '跳到锚点',
          'aria-label': '跳到锚点',
          'data-inherit-anchor-jump': '1',
          onMouseEnter: function () { setHover(true) },
          onMouseLeave: function () { setHover(false) },
          style: {
            position: 'absolute',
            // 位置：输入框右上角外面一点。想再挪就改这两个数（right 越负越靠右，bottom 减得越多越靠下）。
            right: -54,
            bottom: 'calc(100% - 95px)',
            width: 34,
            height: 34,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 0,
            border: 'none',
            borderRadius: 999,
            background: hover ? 'rgba(255,255,255,0.92)' : 'rgba(255,255,255,0.72)',
            backdropFilter: 'blur(6px)',
            boxShadow: '0 2px 10px rgba(0,0,0,0.10)',
            color: hover ? 'var(--dsw-alias-text-primary, #4b5563)' : 'var(--dsw-alias-text-secondary, #6b7280)',
            cursor: busy ? 'default' : 'pointer',
            opacity: busy ? 0.6 : 1,
            transition: 'background 120ms ease, color 120ms ease',
          },
        }, React.createElement('svg', {
          width: 16,
          height: 16,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.8,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
        }, [
          React.createElement('circle', { key: 'dot', cx: 12, cy: 4.6, r: 2.1 }),
          React.createElement('path', { key: 'stem', d: 'M12 20v-7.2' }),
          React.createElement('path', { key: 'head', d: 'M8.6 12.4 12 9l3.4 3.4' }),
        ]))
      } catch (e) {
        report('anchorjump:render', e)
        return null
      }
    }

    function InheritButton(props) {
      try {
        var sessionId = props && props.sessionId ? String(props.sessionId) : ''
        var messageId = props && props.messageId ? String(props.messageId) : ''
        if (sessionId) lastSessionId = sessionId

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
        // 位置由宿主判：它把「锚点之后有哪些消息」算成 id 列表发过来，客户端只查表。
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

    /* ── 「压缩总结已触发」提示曾在这里：那版弹窗已经不用了（压缩过程由按钮状态和
     *    设置页的日志面板体现），函数没人调用，一并删掉，别留死代码。 ── */

    /* ═══ 空壳收尾行：整轮都被遮掉时，把「已完成，用时 N 秒」这些行也藏起来 ═══
     * 探针取到的实况（2026-11-22）：
     *   · 「已完成，用时 N 秒」不在 turn-tail 里，它在 **turn-process** 这一层
     *     （class hE4tRW_root / hE4tRW_label，祖先 div[turn-process]）；
     *   · 「已重试模型请求（1/5）」是另一种节点，kind = **model-retry**。
     * 所以判据按"整除"来：把这一轮的兄弟节点全找出来，剔掉装饰性的那几种，
     * 剩下的内容节点（user / assistant-step / tool-call / context / steering）
     * **全部不可见**才藏这一行；只要有任何一个看得见就一律不动。
     * 只在客户端 DOM 上隐藏，不改数据、不改日志、不碰轮步边界。
     */
    var ROW_SELECTOR = '[data-chat-flow-kind="turn-process"],[data-chat-flow-kind="turn-tail"],[data-chat-flow-kind="model-retry"]'
    // 跳锚点那一下会一次性塞进大量历史，扫描先安静一会儿，等这一波过去再扫一次，
    // 免得"刚加载的行"和"我们的扫描"撞在一起把主线程堵死。
    var rowQuietUntil = 0
    // 跳转结束后踢一脚重扫（安静窗口期间不扫，落地后再补一次）
    var rowKick = null
    var ROW_HIDE_ID = 'dsh-inherit-tail-css'
    var ROW_HIDE_CSS = '[data-inherit-hide-row="1"]{display:none!important}'
    // 这些是装饰/操作行，不算"这一轮的内容"。
    var DECOR_KINDS = ['turn-process', 'turn-tail', 'model-retry', 'user-actions', 'retrace-reference', 'recall-marker', 'turn-head']

    function initEmptyTailHiding() {
      try {
        if (typeof document === 'undefined' || !document.body) return function () {}
        try {
          var hasStyle = typeof document.getElementById === 'function' && document.getElementById(ROW_HIDE_ID)
          if (!hasStyle && document.head && typeof document.createElement === 'function') {
            var tag = document.createElement('style')
            tag.id = ROW_HIDE_ID
            tag.dataset.plugin = 'dsh-inherit-compression'
            tag.textContent = ROW_HIDE_CSS
            document.head.appendChild(tag)
          }
        } catch (e) { report('row:css', e) }

        var kindOf = function (el) {
          try { return el.getAttribute ? (el.getAttribute('data-chat-flow-kind') || '') : '' } catch (e) { return '' }
        }

        var isInvisible = function (el) {
          try {
            if (!el || !el.getBoundingClientRect) return true
            if (el.hidden) return true
            var cs = window.getComputedStyle(el)
            if (cs && (cs.display === 'none' || cs.visibility === 'hidden')) return true
            var rect = el.getBoundingClientRect()
            return rect.height < 2 && rect.width < 2
          } catch (e) { return false } // 量不出来按"可见"，绝不误藏
        }

        // 单遍扫描：顺着聊天列表的兄弟节点走一遍，按「用户消息」切轮，
        // 每轮只统计一次内容节点是否全不可见，再把结论写给这一轮的收尾行。
        // 之前是"每行回头翻四百个兄弟"，行数一多就是 O(行×兄弟)，跳转后上千行直接把主线程压死。
        var lastRun = 0
        var raf = 0
        var scan = function () {
          raf = 0
          lastRun = Date.now()
          dirty = false
          try {
            if (typeof document.querySelectorAll !== 'function') return
            var anyRow = document.querySelector(ROW_SELECTOR)
            if (!anyRow) return
            var list = anyRow.parentElement
            if (!list) return
            var children = list.children
            // 第一段：只读。current = 这一轮的内容节点是否全不可见；decor = 这一轮待处理的收尾行
            var plan = []
            var current = null
            var decor = []
            var flush = function () {
              if (!decor.length) return
              var hide = current !== null && current.count > 0 && current.visible === 0
              for (var q = 0; q < decor.length; q += 1) plan.push([decor[q], hide])
              decor = []
            }
            for (var i = 0; i < children.length; i += 1) {
              var el = children[i]
              var kind = kindOf(el)
              if (kind === 'user') {
                // 新一轮开始
                flush()
                current = { count: 0, visible: 0 }
                continue
              }
              if (kind === '') continue
              if (DECOR_KINDS.indexOf(kind) >= 0) {
                if (current !== null) decor.push(el)
                continue
              }
              if (current === null) continue // 还没遇到用户消息，不算任何一轮
              current.count += 1
              if (!isInvisible(el)) current.visible += 1
            }
            flush()
            // 第二段：只写
            for (var j = 0; j < plan.length; j += 1) {
              var row = plan[j][0]
              var hideIt = plan[j][1]
              if (hideIt) {
                if (row.dataset.inheritHideRow !== '1') row.dataset.inheritHideRow = '1'
              } else if (row.dataset.inheritHideRow === '1') {
                delete row.dataset.inheritHideRow
              }
            }
          } catch (e) { report('row:scan', e) }
        }

        // 节流 + 安静窗口：跳转后一秒半内不扫，等官方那波渲染落地再一次扫完。
        var dirty = true
        var schedule = function () {
          dirty = true
          if (raf) return
          var now = Date.now()
          if (now < rowQuietUntil) {
            raf = setTimeout(function () { raf = 0; schedule() }, rowQuietUntil - now)
            return
          }
          var wait = Math.max(0, 300 - (now - lastRun))
          if (wait === 0) {
            try {
              if (typeof requestAnimationFrame === 'function') {
                raf = requestAnimationFrame(scan)
                return
              }
            } catch (e) { /* 兜底 */ }
            setTimeout(scan, 30)
            return
          }
          raf = setTimeout(function () { raf = 0; if (dirty) scan() }, wait)
        }

        var observer = null
        try {
          if (typeof MutationObserver === 'function') {
            observer = new MutationObserver(schedule)
            // 只盯结构变化：之前连属性变化也听，等于自己改属性又触发自己，白烧 CPU。
            observer.observe(document.body, { childList: true, subtree: true })
          }
        } catch (e) { report('row:observer', e) }

        var onScroll = function () { schedule() }
        try { document.addEventListener('scroll', onScroll, { passive: true, capture: true }) } catch (e) {}

        rowKick = schedule
        scan()
        for (var d = 0; d < 3; d += 1) setTimeout(scan, 200 * (d + 1))

        return function () {
          try { if (observer) observer.disconnect() } catch (e) {}
          try { if (raf) { if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(raf); clearTimeout(raf) } } catch (e) {}
          try { document.removeEventListener('scroll', onScroll, true) } catch (e) {}
          try {
            var styleEl = typeof document.getElementById === 'function' ? document.getElementById(ROW_HIDE_ID) : null
            if (styleEl) styleEl.remove()
          } catch (e) {}
        }
      } catch (e) {
        report('row:init', e)
        return function () {}
      }
    }

    /* ═══ 挂载：等 retrace 自己的 apply 跑完，再往槽里塞我们的两件东西 ═══ */
    function mountInherit(ctx) {
      try { anchorJumpCtx = ctx } catch (e) { /* 忽略 */ }

      try {
        var disposeRows = initEmptyTailHiding()
      } catch (e) { report('row:mount', e) }

      try {
        var mountJump = function () {
          return ctx.slots.inject('conversation.input.overlay', function () {
            return ctx.slots.register({
              name: 'conversation.input.overlay',
              id: 'inherit-anchor-jump',
              order: 60,
              label: '跳到锚点',
            }, AnchorJumpButton)
          })
        }
        if (typeof ctx.effect === 'function') ctx.effect(mountJump)
        else mountJump()
      } catch (e) { report('anchorjump:mount', e) }

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
