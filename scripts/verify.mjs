import { readFile, access } from 'node:fs/promises'

const required = [
  'lib/index.js',
  'lib/client.js',
  'lib/protocol.js',
  'lib/types/index.d.ts',
  'lib/types/client/index.d.ts',
  'cordis.patch.yml',
]

for (const file of required) await access(new URL(`../${file}`, import.meta.url))
const client = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
if (!client.includes('window.__ModuleLoader__.load')) throw new Error('client bundle lacks the official DSH module-loader wrapper')
if (!client.includes('@harness-remote/dsh-realtime-voice')) throw new Error('client bundle is registered under the wrong package id')
if (client.includes('DASHSCOPE_API_KEY') && client.includes('Bearer ')) {
  throw new Error('client bundle appears to contain Host credential logic')
}
console.log('artifact verification passed')
