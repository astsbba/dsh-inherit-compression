/**
 * 一次性清洗：把上游名 dsh-retrace 换成 dsh-inherit-compression。
 *
 * 为什么用脚本而不是手改：这些是分散在十几个字符串里的标识（日志前缀、localStorage 键、
 * 样式表 id、pluginDataHome 目录名、cordis effect 标签），手改容易漏；而且我已经被
 * PowerShell 的编码坑过一次，这里全程走 Node 的 UTF-8 读写，不经 shell。
 *
 * 只改「dsh-retrace 后面不跟 -inherit」的那些，避免把已经改好的再改一遍。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const here = (p) => fileURLToPath(new URL(p, import.meta.url))
const PATTERN = /dsh-retrace(?!-inherit)/g
const FROM = 'dsh-retrace'
const TO = 'dsh-inherit-compression'

const HOST_FILES = [
  './lib/index.js',
  './lib/http.js',
  './lib/close-guard.js',
]

let changed = 0
for (const rel of HOST_FILES) {
  const file = here(rel)
  if (!existsSync(file)) continue
  const src = readFileSync(file, 'utf8')
  const count = (src.match(PATTERN) || []).length
  if (count === 0) continue
  writeFileSync(file, src.replace(PATTERN, TO), 'utf8')
  console.log(`${rel}: 替换 ${count} 处`)
  changed += count
}
console.log(`宿主侧共替换 ${changed} 处（${FROM} → ${TO}）`)
