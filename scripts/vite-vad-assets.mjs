/**
 * vite-vad-assets.mjs — ship the voice-activity detector's files with every build and dev server.
 *
 * `@ricky0123/vad-web` and the onnxruntime-web it runs on fetch four files at run time: the audio
 * worklet, the Silero model, and onnxruntime's .mjs loader with its .wasm. By default they look
 * beside the page ("./"), where no build put them, so a static host answered with index.html and
 * voice input never started. This plugin takes the files from the installed packages, the versions
 * pnpm-lock.yaml pins, and serves them from the app's own origin (this app loads nothing from a CDN):
 *
 *   - build:      <outDir>/assets/vad/<fingerprint>/<file>, with their licences beside them, and
 *                 <outDir>/vad-assets.json, which lists them for scripts/smoke-live.mjs;
 *   - dev server: the same URLs, read from node_modules. A name it does not have is a 404, not the app;
 *   - the app:    `__CI_AVATAR_VAD_DIR__`, the folder relative to Vite's `base`, which
 *                 packages/core/src/services/vad/vadAssets.ts hands to MicVAD.
 *
 * The folder is named after the files' bytes because every host caches /assets/* for a year
 * (apps/web/public/_headers, nginx/default.conf): another version of a package gets another URL.
 *
 * It copies with node:fs and adds no dependency. Plain JavaScript, like check-pwa.mjs, so that
 * `vite build`, `deno task build` and `node` can all run it.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Where the files go in the build output, under /assets/ so a missing one is not the app (see the top). */
export const VAD_DIR = 'assets/vad'

/** The list of the files a build shipped, at the root of the output. */
export const VAD_MANIFEST = 'vad-assets.json'

/** The licence texts shipped beside the files. */
export const VAD_LICENSES = 'LICENSES.txt'

/** The compile-time constant that carries the folder to packages/core. */
export const VAD_DEFINE = '__CI_AVATAR_VAD_DIR__'

/**
 * What the app asks for when it runs the Silero v5 model (the only one it uses), and which package
 * each comes from. onnxruntime's name is the one its wasm-only build, `onnxruntime-web/wasm`, asks
 * for; the jsep and asyncify builds beside it are for WebGPU, which vad-web does not use.
 */
export const VAD_FILES = [
  { name: 'silero_vad_v5.onnx', from: 'vad-web' },
  { name: 'vad.worklet.bundle.min.js', from: 'vad-web' },
  { name: 'ort-wasm-simd-threaded.mjs', from: 'onnxruntime-web' },
  { name: 'ort-wasm-simd-threaded.wasm', from: 'onnxruntime-web' }
]

const CONTENT_TYPES = {
  js: 'text/javascript',
  mjs: 'text/javascript',
  wasm: 'application/wasm',
  txt: 'text/plain; charset=utf-8',
  onnx: 'application/octet-stream'
}

/**
 * The files as installed: vad-web as packages/core resolves it, and onnxruntime-web as that vad-web
 * resolves it. (vits-web, the local text-to-speech, pins another onnxruntime-web, so resolving it
 * from anywhere else could pick the wrong one.)
 */
export function readVadAssets(root = ROOT) {
  const fromCore = createRequire(join(root, 'packages/core/package.json'))
  const vadManifest = fromCore.resolve('@ricky0123/vad-web/package.json')
  const ortDist = dirname(createRequire(vadManifest).resolve('onnxruntime-web/wasm'))
  const dirs = { 'vad-web': join(dirname(vadManifest), 'dist'), 'onnxruntime-web': ortDist }
  const version = (manifest) => JSON.parse(readFileSync(manifest, 'utf8')).version

  const files = VAD_FILES.map(({ name, from }) => ({ name, bytes: readFileSync(join(dirs[from], name)) }))
  files.push({ name: VAD_LICENSES, bytes: readFileSync(join(root, 'scripts/third-party/licenses/voice-activity.txt')) })

  const hash = createHash('sha256')
  for (const { name, bytes } of files) hash.update(name).update('\0').update(bytes).update('\0')
  const dir = `${VAD_DIR}/${hash.digest('hex').slice(0, 12)}`

  return {
    dir,
    files,
    versions: {
      '@ricky0123/vad-web': version(vadManifest),
      'onnxruntime-web': version(join(ortDist, '..', 'package.json'))
    }
  }
}

/** The manifest a build writes: the versions and the paths, relative to the app's base. */
export function vadManifest({ dir, files, versions }) {
  return `${JSON.stringify({ versions, files: files.map(({ name }) => `${dir}/${name}`) }, null, 2)}\n`
}

/**
 * Answer a dev-server request for a file under /assets/vad/, whatever the base and the query (Vite
 * adds `?import` to the dynamic import of the .mjs loader). Any other request goes on.
 */
export function vadMiddleware(assets) {
  return (req, res, next) => {
    const path = String(req.url ?? '').split(/[?#]/)[0]
    const at = path.indexOf(`/${VAD_DIR}/`)
    if (at === -1) return next()
    const asked = path.slice(at + 1)
    const file = assets.files.find(({ name }) => asked === `${assets.dir}/${name}`)
    if (!file) {
      res.statusCode = 404
      res.setHeader('Content-Type', CONTENT_TYPES.txt)
      return res.end('Not found')
    }
    res.statusCode = 200
    res.setHeader('Content-Type', CONTENT_TYPES[file.name.split('.').pop()])
    res.setHeader('Content-Length', file.bytes.length)
    res.setHeader('Cache-Control', 'no-cache')
    return res.end(req.method === 'HEAD' ? undefined : file.bytes)
  }
}

/** The Vite plugin. Every app that bundles packages/core's voice input needs it. */
export function vadAssets() {
  let assets = null
  let ssr = false
  const load = () => (assets ??= readVadAssets())

  return {
    name: 'ci-avatar-vad-assets',
    config() {
      return { define: { [VAD_DEFINE]: JSON.stringify(`${load().dir}/`) } }
    },
    configResolved(config) {
      ssr = Boolean(config.build.ssr)
    },
    // Registered before Vite's own middlewares, so these URLs are never transformed or given the app.
    configureServer(server) {
      server.middlewares.use(vadMiddleware(load()))
    },
    generateBundle() {
      if (ssr) return
      for (const { name, bytes } of load().files) {
        this.emitFile({ type: 'asset', fileName: `${load().dir}/${name}`, source: bytes })
      }
      this.emitFile({ type: 'asset', fileName: VAD_MANIFEST, source: vadManifest(load()) })
    }
  }
}
