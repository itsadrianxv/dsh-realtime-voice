import { readFile } from 'node:fs/promises'
import { basename, dirname, resolve as resolvePath } from 'node:path'
import { transform } from 'lightningcss'
import { defineConfig, type UserConfig } from 'tsdown'

const PACKAGE_ID = '@harness-remote/dsh-realtime-voice'
const CSS_PREFIX = '\0dsh-voice-css:'
const CSS_SUFFIX = '.mjs'
const CLIENT_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-api-remotes/client',
  '@deepseek-ai/dsh-client-connection/client',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-attachment',
  '@deepseek-ai/dsh-client-schema-form',
  '@deepseek-ai/dsh-client-runtime/client',
  '@deepseek-ai/dsh-client-ui-settings/client',
  '@deepseek-ai/dsh-client-ui-settings-plugins/client',
]

const cssPlugin: NonNullable<UserConfig['plugins']>[number] = {
  name: 'dsh-realtime-voice-css-modules',
  resolveId(source: string, importer?: string) {
    if (!source.endsWith('.module.css')) return null
    const absolute = importer === undefined ? source : resolvePath(dirname(importer), source)
    return CSS_PREFIX + absolute + CSS_SUFFIX
  },
  async load(id: string) {
    if (!id.startsWith(CSS_PREFIX)) return null
    const file = id.slice(CSS_PREFIX.length, -CSS_SUFFIX.length)
    this.addWatchFile(file)
    const source = await readFile(file)
    const result = transform({ filename: file, code: source, cssModules: { pattern: '[hash]_[local]' }, minify: true })
    const classes: Record<string, string> = {}
    for (const [local, value] of Object.entries(result.exports ?? {})) classes[local] = value.name
    const styleId = `${PACKAGE_ID}/${basename(file)}`
    return [
      `const css=${JSON.stringify(result.code.toString())};`,
      `const styleId=${JSON.stringify(styleId)};`,
      'if(typeof document!=="undefined"&&!document.querySelector(`style[data-plugin-css="${styleId}"]`)){',
      'const style=document.createElement("style");',
      `style.dataset.plugin=${JSON.stringify(PACKAGE_ID)};`,
      'style.dataset.pluginCss=styleId;style.textContent=css;document.head.appendChild(style);}',
      `export default ${JSON.stringify(classes)};`,
    ].join('\n')
  },
}

export default defineConfig([
  {
    name: PACKAGE_ID,
    entry: { index: 'src/index.ts', protocol: 'src/protocol.ts', 'direct-protocol': 'src/direct-protocol.ts' },
    outDir: 'lib',
    format: 'esm',
    fixedExtension: false,
    platform: 'node',
    target: 'node22',
    dts: false,
    sourcemap: true,
    clean: false,
    deps: { neverBundle: [/^@deepseek-ai\//, 'ws'] },
  },
  {
    name: `${PACKAGE_ID}/client`,
    entry: { client: 'src/client/index.ts' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    target: 'es2022',
    dts: false,
    sourcemap: true,
    clean: false,
    deps: { neverBundle: CLIENT_EXTERNALS },
    plugins: [cssPlugin],
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PACKAGE_ID)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
])
