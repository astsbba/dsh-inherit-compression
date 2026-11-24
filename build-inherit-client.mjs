/**
 * 把继承功能缝进 retrace 的客户端 bundle，并抹掉我们不要的界面。
 *
 * web 的模块加载器一个文件只激活一个模块：文件里 `window.__ModuleLoader__.load`
 * 注册的 id 会被运行器用自己的 pluginId 覆盖，再多写一个 load() 也没人调用。
 * 所以只能改它这个唯一的模块：在工厂作用域末尾插一段代码，把 `apply` 包一层，
 * 让 retrace 自己挂完槽之后，再把继承按钮和设置页挂上去。
 *
 * 顺手做的界面删减（都是本 fork 的决定，不改上游源文件，全集中在这里）：
 *   ① 撤回确认弹窗里那句「原内容之后可用该标记上的『恢复显示』找回」——功能都砍了，
 *      留着就是在指一个不存在的按钮。
 *   ② 标记行上的「恢复显示」「真正恢复」两个按钮——开关是渲染前算的两个布尔值，
 *      把它们钉成 false，按钮就不渲染（今天起撤回就是撤回，没有后悔药）。
 *   ③ 底部那条「已累积隐藏 N%…点恢复显示找回」的提示里的后半句。
 *
 *   node build-inherit-client.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const here = (p) => fileURLToPath(new URL(p, import.meta.url))

const base = readFileSync(here('./build/client.retrace.bundle.js'), 'utf8')
const part = readFileSync(here('./build/inherit-client.part.js'), 'utf8')

/** bundle 里非 ASCII 字符是 \uXXXX 转义形式，按同样规则转一遍再去找。 */
const esc = (text) => text.split('').map((ch) => {
  const code = ch.codePointAt(0)
  if (code < 128) return ch
  return '\\u' + code.toString(16).toUpperCase().padStart(4, '0')
}).join('')

// ① 模块 id、日志前缀、localStorage 键、样式表 id、data-plugin 标记统一换成本包名。
//    源文件保持上游原样，改名在构建时做——重建一次就还原干净。
const ID_FROM = 'id: "dsh-retrace",'
if (!base.includes(ID_FROM)) throw new Error('没找到加载器 id，bundle 结构变了')
const RENAME = /dsh-retrace(?!-inherit)/g
let out = base.replace(RENAME, 'dsh-inherit-compression')
const leftover = (out.match(RENAME) || []).length
if (leftover > 0) throw new Error(`改名没扫干净：还能找到 ${leftover} 处 dsh-retrace`)

// ② 界面删减
const PATCHES = [
  {
    label: '撤回确认弹窗（中文）',
    from: '撤回后本条及其后的对话将从此处重新继续；原内容之后可用该标记上的「恢复显示」找回。',
    to: '撤回后本条及其后的对话将从此处重新继续。',
  },
  {
    label: '撤回确认弹窗（英文）',
    from: 'This message and everything after it continue from here; the original content can be brought back later with “Restore display” on this marker.',
    to: 'This message and everything after it continue from here.',
  },
  {
    // 「已累积隐藏约 N%」这条提示整条不要了（连带词表）：我们本来就是整段收，
    // 它恒等于 100%，纯噪声。注意这里匹配的是**上游原文**（带「点恢复显示」后半句），
    // 词表条目整行删掉，不留悬空引用。
    label: '删掉累积隐藏比例词条（中文）',
    from: '"marker.unionHint":"已累积隐藏约 {count}% 的历史消息；在任一标记行点「恢复显示」即可找回被撤回的内容。",',
    to: '',
  },
  {
    label: '删掉累积隐藏比例词条（英文）',
    from: '"marker.unionHint":\'About {count}% of the history is hidden in total; click "Restore display" on any marker row to bring recalled content back.\',',
    to: '',
  },
  {
    label: '恢复显示按钮开关',
    from: 'const canUnhide=',
    to: 'const canUnhide=false&&',
  },
  {
    label: '真正恢复按钮开关',
    from: 'const canTrueRestore=',
    to: 'const canTrueRestore=false&&',
  },
  {
    // 标记下面那块「▸ 原输入：……」的可展开块。改成直接返回 null：
    // 槽位照旧注册，但什么都不画，不会留一个空壳子。
    label: '原输入参考块',
    from: 'function ReferenceRow({node,useChat,t}){const{seq,messageId}=node.data;',
    to: 'function ReferenceRow({node,useChat,t}){return null;const{seq,messageId}=node.data;',
  },
  {
    // 整个「读档点」视图（时间线 / 回档 / git），连带它里面的清理标题、启用 git 按钮。
    // void(...) 只构造那个箭头函数、不调用 mountSlot，所以这个 tab 不再注册；
    // 视图内部才用到的 jumpToAnchor/switchToViewTab 也就没有入口了。
    label: '读档点视图',
    from: 'mountSlot("conversation.view",',
    to: 'void("conversation.view",',
  },
  {
    // 标记行上那句「已撤回 N 条消息」。撤回不需要恢复，这句话就没意义了。
    // 注意不能把整个标记组件去掉：隐藏那些行的 CSS 也在同一个组件里（第一条 child）。
    label: '标记行文字',
    from: '!dismissed&&(0,import_react.createElement)("div",{key:"label",className:"dsh-rt-marker",role:"status"},label)',
    to: '!1&&(0,import_react.createElement)("div",{key:"label",className:"dsh-rt-marker",role:"status"},label)',
  },
  {
    // 用户消息那排的「撤回」按钮。它和「编辑」本质是同一件事（撤回后改内容重发），
    // 留一个就够；删掉撤回，编辑还在。撤回确认弹窗因此也走不到了。
    label: '用户消息的撤回按钮',
    from: '(0,import_react.createElement)("button",{key:"recall",type:"button",className:"dsh-rt-chip dsh-rt-user-action","data-op":"recall",title:t("action.recallUser"),"aria-label":t("action.recallUser"),disabled:busy||pausing,onClick:()=>{setFailure(null);setConfirming(true)}},t("action.recall"))',
    to: 'null',
  },
  {
    // 撤回的确认弹窗（那个遮罩层）。按钮都没了，这里直接钉死不渲染。
    label: '撤回确认弹窗',
    from: 'confirming&&(0,import_react.createElement)("div",{key:"recall-confirm"',
    to: '!1&&(0,import_react.createElement)("div",{key:"recall-confirm"',
  },
  {
    // 上游那句「大范围遮蔽」安全阀提示：判据是纯几何的（节点数 + 占比），编辑重发、
    // 重新生成盖得够大也会蹦出来。用户不要阈值警告 —— 整段渲染剪掉（变量钉成 null，
    // 引用它的那处保留，值为 null 自然不渲染），改由我们的注入段在真的调了模型压缩
    // 之后弹一条 5 秒提示。
    //
    // ⚠️ 只剪「渲染」，不动 plan.degraded / shadowDegraded()：那套还管着
    //    「大范围时是否真的隐藏这些行」的开关（fold 才允许降级隐藏），
    //    剪掉会让大范围撤回把历史行真的藏起来。
    label: '剪掉上游的大范围遮蔽提示（渲染）',
    from: 'const degradedHint=!legacy&&plan?.degraded===true?(0,import_react.createElement)("div",{key:"degraded",className:"dsh-rt-marker-hint"},t("marker.degradedHint")):null;',
    to: '',
  },
  {
    // 隐藏开关里的「例外」分支：只有 op==='fold' 才允许「因为范围大所以不隐藏」。
    // 我们的标记 op 是 recall，永远不会命中，等于空转；而且 retrace 的自动 fold 本来
    // 就被写死禁止（AUTOFOLD_HARD_DISABLED）。这里整段拿掉 ⇒ 行为恒定「该隐就隐」。
    // shadowDegraded()/plan.degraded 字段本身留着（诊断面板还在用），只删这处判断。
    label: '剪掉隐藏的 degraded 例外分支',
    from: 'const degradeAllowed=op==="fold";const hiddenKeys=legacy?null:plan?.degraded===true&&degradeAllowed?null:plan?.keys??null;',
    to: 'const hiddenKeys=legacy?null:plan?.keys??null;',
  },
  {
    // 用户消息那排的「编辑」按钮：文字换成一支自己画的笔（不套上游任何图标），
    // 描边走 currentColor，颜色比正文淡一档；显隐交给注入段的 CSS/扫描控制
    // （只有最新一条常显，旧的靠近/聚焦才浮现）。
    label: '编辑按钮换成自绘笔形图标',
    from: ',onClick:openEditor},t("action.edit")',
    to: ',onClick:openEditor},(0,import_react.createElement)("svg",{width:15,height:15,viewBox:"0 0 24 24",fill:"none",stroke:"currentColor",strokeWidth:1.7,strokeLinecap:"round",strokeLinejoin:"round","aria-hidden":true},[(0,import_react.createElement)("path",{key:"p1",d:"M4.5 19.5l1-4.2L15.8 5a2.9 2.9 0 0 1 4.1 4.1L9.6 19.5H4.5z"}),(0,import_react.createElement)("path",{key:"p2",d:"M14.4 6.6l3 3"})])',
  },
  {
    // 「已累积隐藏约 N%」这条提示整条不要了：我们本来就是整段收，它恒等于 100%，
    // 纯噪声。词表条目已在上面删掉，这里把渲染那句连同变量一起删。
    label: '删掉「已累积隐藏 N%」提示（渲染）',
    from: 'const unionHint=!legacy&&hidePlan.firstMarkerKey===node.key&&hidePlan.rowCount>SHADOW_MIN_ROWS_FOR_RATIO&&hidePlan.unionRatio>SHADOW_SAFETY_RATIO?(0,import_react.createElement)("div",{key:"union",className:"dsh-rt-marker-hint"},t("marker.unionHint",{count:Math.round(hidePlan.unionRatio*100)})):null;',
    to: '',
  },
  {
    // 上面两条渲染都删了，标记行数组里那两处引用也要一起摘掉，
    // 否则就是悬空变量（构建会直接报错，不会带病出厂）。
    label: '摘掉标记行里对两条提示的引用',
    from: ',!dismissed&&degradedHint,!dismissed&&unionHint])',
    to: '])',
  },
  {
    // 「重发（从这条重开）」→「重新发送」；顺手把那句长提示（它挂在按钮 title 上，
    // 界面上会当成一行说明画出来）整条摘掉，连同两份词条。
    label: '重发按钮文案（中文）',
    from: '"action.sendFromHere":"重发（从这条重开）"',
    to: '"action.sendFromHere":"重新发送"',
  },
  {
    label: '重发按钮文案（英文）',
    from: '"action.sendFromHere":"Resend (restart from here)"',
    to: '"action.sendFromHere":"Resend"',
  },
  {
    label: '摘掉重发按钮上的长提示',
    from: ',title:t("action.sendFromHereHint")',
    to: '',
  },
  {
    label: '删掉重发提示词条（中文）',
    from: '"action.sendFromHereHint":"重发即重开：本条及其后将被替换／隐藏，后续进入新的时间线分支。范围过大时守卫会拒绝，届时错误提示里会给出「仅改文本（保留后续）」。",',
    to: '',
  },
  {
    label: '删掉重发提示词条（英文）',
    from: '"action.sendFromHereHint":"Resending restarts from here: this message and everything after it will be replaced/hidden and continue on a new timeline branch. Large ranges are refused by the guard — then the error offers \\u201CChange this text only (keep what follows)\\u201D.",',
    to: '',
  },
  {
    // 上面那条一剪，这两份词表条目就没主了，一并删掉。
    label: '删掉遮蔽提示词条（中文）',
    from: '"marker.degradedHint":"此操作涉及大范围对话，为保护历史未隐藏内容（日志完好）。",',
    to: '',
  },
  {
    label: '删掉遮蔽提示词条（英文）',
    from: '"marker.degradedHint":"This operation spans a large part of the conversation; content stays visible to protect your history (the log is intact).",',
    to: '',
  },
  {
    // 编辑器那条提交路径直接把 HTTP 状态码当提示文字显示，会在按钮下面闪一下
    // 裸的 “HTTP 400”。操作其实成功了（那是重复/被取消的请求），这行噪声没有
    // 诊断价值，滤掉：纯状态码就不显示，其余错误照旧显示。
    label: '滤掉裸 HTTP 状态码提示',
    from: 'setFailure(error?.message??t("error.generic"))',
    to: 'setFailure((function(m){return /^HTTP \\d+$/.test(m)?null:(m||t("error.generic"))})(String(error?.message??"")))',
    all: true,
  },
  {
    // 「遮蔽占比过大就降级、干脆一条都不藏」这条兜底，整个关掉。
    // 原因：那会让被遮蔽的行照常显示，而我们已经把它们的内容换成了占位——
    // 用户看到的就是一串空白、点不开的消息。既然要瘦，就必须配套"该隐就隐"。
    label: '关掉遮蔽降级（shadowDegraded 恒 false）',
    from: 'function shadowDegraded(keys,rowCount){return keys!==null&&rowCount>SHADOW_MIN_ROWS_FOR_RATIO&&keys.length/rowCount>SHADOW_SAFETY_RATIO}',
    to: 'function shadowDegraded(keys,rowCount){return false}',
  },
  {
    // 「消息编辑插件」那块设置面板（settings.general.item / OptionsRow）：整块删掉。
    // 里面七个开关，读档点与产物快照 / AI 摘要 / git 集成 / 读档点保留上限四项的宿主
    // 实现已经拆了（点了没反应），剩下两项（编辑后显示原提问对照、退出确认）我们也不用。
    // 同样用 void(...) 让那个 mountSlot 不执行 ⇒ 槽位不再注册，面板彻底消失。
    label: '消息编辑插件设置面板',
    from: 'mountSlot("settings.general.item",',
    to: 'void("settings.general.item",',
  },
]

for (const patch of PATCHES) {
  const from = esc(patch.from)
  const to = esc(patch.to)
  const hits = out.split(from).length - 1
  if (patch.all === true) {
    if (hits < 1) throw new Error(`${patch.label}：一处都没命中`)
    out = out.split(from).join(to)
    continue
  }
  if (hits !== 1) throw new Error(`${patch.label}：应当唯一命中，实际 ${hits} 处`)
  out = out.replace(from, to)
}

// ③ 在工厂收尾之前插入我们的挂载代码
const ANCHOR = '\n\t\tObject.defineProperty(module.exports, Symbol.toStringTag, { value: "Module" });'
const anchorHits = out.split(ANCHOR).length - 1
if (anchorHits !== 1) throw new Error(`工厂收尾锚点应当唯一，实际 ${anchorHits} 个`)

out = out.replace(
  ANCHOR,
  '\n/* ===== dsh-inherit-compression: 继承功能（由 build-inherit-client.mjs 注入） ===== */\n'
  + part.trim() + '\n'
  + ANCHOR,
)

writeFileSync(here('./lib/client.bundle.js'), out)
console.log(`client.bundle.js 生成完毕：${out.length} 字节（原 ${base.length}，注入 ${part.length}，界面删减 ${PATCHES.length} 处）`)
