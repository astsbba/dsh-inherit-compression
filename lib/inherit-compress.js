/**
 * dsh-inherit-compression · 压缩
 *
 * 把「上一块记忆 + 锚点之后新增的对话」交给用户指定的模型，按用户自己的提示词
 * 压成一块可以直接塞回会话的前情记忆。只走 ctx.llm，不碰 DSH 自带压缩，
 * 所以提示词、模型、目标长度全由这个插件说了算。
 */

export const DEFAULT_PROMPT = [
  '你是一个长期记忆压缩器，服务对象是一个正在延续的会话。',
  '把给你的这段对话压成一份可以直接塞回会话的「前情记忆」，让读到它的人能毫不费力地接着聊下去。',
  '',
  '必须保留：',
  '1. 人物、称呼、关系、说话习惯，尤其是对方的语气、偏好、雷点。',
  '2. 已经确定的事实、决定、结论、数字、路径、名字、接口名。',
  '3. 正在进行但还没做完的事，以及下一步本来打算做什么。',
  '4. 踩过的坑和已经排除的方案，不要让人再踩一遍。',
  '',
  '必须丢掉：',
  '1. 寒暄、客套、重复确认。',
  '2. 已经作废的中间过程。',
  '3. 大段贴过来的原文，只留它解决了什么。',
  '',
  '写法要求：',
  '- 用第二人称对「正在接着聊的人」说话，不用第三人称转述视角。',
  '- 按主题分段，不按时间流水账。',
  '- 直接给结论和上下文，不要写「用户说」「助手回答」这类壳子。',
  '- 篇幅按信息密度给，一般不超过一千二百字。',
].join('\n')

/**
 * 剔掉我们自己贴进去的那一整块「近期对话」。
 *
 * 为什么必须有：注入是写进用户消息里的，下一次压缩取材时它又被当成正文抓进去，
 * 于是「记忆里套着上一次的注入块」，压一次套一层，越滚越乱（实测日志里能看到
 * head="对方：[近期对话] 对方：…" 这种嵌套）。这是我们自己的产物，扫到就整段拿掉。
 */
export function stripInjected(text) {
  const raw = String(text ?? '')
  if (raw.indexOf('[近期对话]') < 0) return raw
  let out = raw
  // 新版指令尾巴
  out = out.replace(/\[近期对话\][\s\S]*?给出符合当前情境的回答。[ \t]*\n*/g, '')
  // 旧版指令尾巴（历史消息里还留着这种，扫到也清掉）
  out = out.replace(/\[近期对话\][\s\S]*?请你根据上述内容做出符合人设的回答。[ \t]*\n*/g, '')
  // 兜底：认不出尾巴就按排版切——注入块后面固定是两个空行
  out = out.replace(/\[近期对话\][\s\S]*?\n\n\n/g, '')
  return out.trim()
}

/** 把若干消息拍平成一段纯文本。
 *
 * @param {object[]} messages
 * @param {{tools?: boolean, oneLine?: boolean, compact?: boolean}} [options]
 *   tools   = false：滤掉工具调用与工具结果（只留人说的话）；
 *   oneLine = true ：同一段话内部的换行压成空格；
 *   compact = true ：人设样本模式——人物写成 <我> / <对方>，每条之间只换行不空行。
 */
export function flattenMessages(messages, { tools = true, oneLine = false, compact = false } = {}) {
  const out = []
  for (const m of messages) {
    if (!m || typeof m !== 'object') continue
    // 「人设样本」只留正文：工具结果（role=tool）和系统话都不是对话内容，
    // 一条 pwsh 输出几千字，混进去只会把语气样本淹掉。
    if (!tools && (m.role === 'tool' || m.role === 'system')) continue
    const pieces = []
    if (Array.isArray(m.content)) {
      for (const b of m.content) {
        if (!b) continue
        if (b.type === 'text' && typeof b.text === 'string') {
          const clean = stripInjected(b.text)
          if (clean.trim() !== '') pieces.push(clean)
        }
        else if (tools && b.type === 'tool-call') pieces.push(`[调用工具 ${b.name}] ${String(b.arguments ?? '').slice(0, 400)}`)
        else if (b.type === 'image') pieces.push('[图片]')
        else if (b.type === 'file') pieces.push('[文件]')
      }
    }
    let text = pieces.join('\n').trim()
    if (text === '') continue
    if (oneLine || compact) text = text.replace(/[ \t]*\n[\s]*/g, ' ').replace(/\s{2,}/g, ' ').trim()
    if (text === '') continue
    // 角色标签：压缩正文用「我／对方」，人设样本用尖括号把两个人分开
    const me = compact ? '<我>' : '我'
    const other = compact ? '<对方>' : '对方'
    const tag = m.role === 'assistant' ? me : m.role === 'user' ? other : m.role === 'tool' ? '工具结果' : '系统'
    // 正文里自己带了同样的前缀就剥掉，免得出现"我：我：……"这种重复
    const stripped = (oneLine || compact) ? text.replace(/^(我|对方|助手|<我>|<对方>)\s*[：:]\s*/, '') : text
    const body = stripped === '' ? text : stripped
    // 人设样本不要冒号：<对方>消息 这种贴着念更清楚
    out.push(compact ? `${tag}${body}` : `${tag}：${body}`)
  }
  return out.join(compact ? '\n' : '\n\n')
}

/** 从流式响应里攒出完整文本。 */
export async function collectStream(stream) {
  let text = ''
  for await (const chunk of stream) {
    if (!chunk || typeof chunk !== 'object') continue
    if (chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
    if (chunk.type === 'finish' && chunk.reason && chunk.reason.kind === 'error') {
      throw new Error((chunk.reason.failure && chunk.reason.failure.message) || '模型调用失败')
    }
  }
  return text.trim()
}

/**
 * 压一次，返回新的记忆块。
 * @param {object} llm - ctx.llm
 * @param {{provider:string,model:string,prompt?:string,prevBlock?:string,text:string,maxChars?:number,signal?:AbortSignal}} args
 * @returns {Promise<string>}
 */
export async function compressBlock(llm, { provider, model, prompt, prevBlock, text, maxChars, signal }) {
  const sections = []
  if (prevBlock && prevBlock.trim() !== '') {
    sections.push(`【更早之前的记忆，需要一并融进新的记忆里】\n${prevBlock}`)
  }
  sections.push(`【本轮新增的对话】\n${text}`)
  sections.push('现在输出合并后的完整记忆。只输出记忆正文，不要任何前言、不要代码块围栏。')

  const stream = llm.stream({
    provider,
    model,
    system: prompt || DEFAULT_PROMPT,
    messages: [{ role: 'user', content: [{ type: 'text', text: sections.join('\n\n') }] }],
    temperature: 0.3,
    signal,
  })
  const raw = await collectStream(stream)
  if (raw === '') throw new Error('压缩返回了空内容')
  if (maxChars > 0 && raw.length > maxChars) return raw.slice(0, maxChars)
  return raw
}
