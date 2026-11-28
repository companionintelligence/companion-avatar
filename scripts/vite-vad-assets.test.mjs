import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { npmClosure, parsePnpmLock } from './third-party-notices.mjs'
import {
  VAD_DEFINE,
  VAD_FILES,
  VAD_LICENSES,
  VAD_MANIFEST,
  VAD_ORT_NOTICES,
  ortNoticesPath,
  readVadAssets,
  vadAssets,
  vadManifest,
  vadMiddleware
} from './vite-vad-assets.mjs'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (relative) => readFileSync(path.join(root, relative), 'utf8')
const assets = readVadAssets()
const bytesOf = (name) => assets.files.find((file) => file.name === name).bytes

describe('the files', () => {
  it('are the four the detector asks for, their licences and ONNX Runtime\'s notices', () => {
    expect(assets.files.map((file) => file.name)).toEqual([...VAD_FILES.map((file) => file.name), VAD_LICENSES, VAD_ORT_NOTICES])
    expect(assets.dir).toMatch(/^assets\/vad\/[0-9a-f]{12}$/)
    expect(readVadAssets().dir).toBe(assets.dir)
  })

  it('come from the versions pnpm-lock.yaml pins for vad-web, not another onnxruntime-web', () => {
    const closure = [...npmClosure(parsePnpmLock(read('pnpm-lock.yaml')), ['packages/core']).values()]
    const vad = closure.filter((p) => p.name === '@ricky0123/vad-web')
    expect(vad.map((p) => p.version)).toEqual([assets.versions['@ricky0123/vad-web']])
    // The lockfile holds two onnxruntime-web versions (vits-web pins an older one).
    expect(read('pnpm-lock.yaml')).toContain(
      `  '@ricky0123/vad-web@${assets.versions['@ricky0123/vad-web']}':\n    dependencies:\n      onnxruntime-web: ${assets.versions['onnxruntime-web']}\n`
    )
  })

  it('are byte for byte the installed ones', () => {
    const vadDir = path.dirname(createRequire(path.join(root, 'packages/core/package.json')).resolve('@ricky0123/vad-web/package.json'))
    expect(bytesOf('silero_vad_v5.onnx').equals(readFileSync(path.join(vadDir, 'dist/silero_vad_v5.onnx')))).toBe(true)
    // A real .wasm begins with its magic number.
    expect([...bytesOf('ort-wasm-simd-threaded.wasm').subarray(0, 4)]).toEqual([0, 0x61, 0x73, 0x6d])
  })

  it('ship with the three licences their terms ask for', () => {
    const text = bytesOf(VAD_LICENSES).toString('utf8')
    expect(text).toContain('Copyright (c) 2022-present ricky0123')
    expect(text).toContain('Copyright (c) 2020-present Silero Team')
    expect(text).toContain('Copyright (c) Microsoft Corporation')
    expect(text).toContain('https://gitlab.com/libeigen/eigen')
  })

  it('ship the notices of the installed onnxruntime-web, Eigen\'s MPL among them', () => {
    const notices = bytesOf(VAD_ORT_NOTICES).toString('utf8')
    expect(notices.startsWith('THIRD PARTY SOFTWARE NOTICES AND INFORMATION')).toBe(true)
    expect(notices).toMatch(/\nEigen\n\nMPL v2\.0\nMozilla Public License Version 2\.0\n/)
    // NOTICE.md names the file, so a new onnxruntime-web brings a new copy and a new line there.
    expect(read('NOTICE.md')).toContain(ortNoticesPath(assets.versions['onnxruntime-web']))
  })
})

describe('the build', () => {
  const emit = (ssr) => {
    const plugin = vadAssets()
    const defined = plugin.config()
    plugin.configResolved({ build: { ssr } })
    const emitted = []
    plugin.generateBundle.call({ emitFile: (file) => emitted.push(file) })
    return { defined, emitted }
  }

  it('writes every file, the list of them, and tells the app the folder', () => {
    const { defined, emitted } = emit(false)
    expect(defined.define[VAD_DEFINE]).toBe(JSON.stringify(`${assets.dir}/`))
    expect(emitted.map((file) => file.fileName)).toEqual([...assets.files.map((file) => `${assets.dir}/${file.name}`), VAD_MANIFEST])
    expect(JSON.parse(vadManifest(assets)).files).toEqual(assets.files.map((file) => `${assets.dir}/${file.name}`))
  })

  it('writes nothing into a server build', () => {
    expect(emit(true).emitted).toEqual([])
  })

  it('is in the Vite config of every app that has voice input', () => {
    for (const config of ['apps/web/vite.config.ts', 'apps/vision-pro/vite.config.ts']) {
      expect(read(config), config).toMatch(/^ {4}vadAssets\(\)/m)
    }
  })
})

describe('the dev server', () => {
  const ask = (url, method = 'GET') => {
    const res = { statusCode: null, headers: {}, body: undefined, passed: false }
    res.setHeader = (name, value) => (res.headers[name] = value)
    res.end = (body) => (res.body = body)
    vadMiddleware(assets)({ url, method }, res, () => (res.passed = true))
    return res
  }

  it.each([
    ['silero_vad_v5.onnx', 'application/octet-stream'],
    ['vad.worklet.bundle.min.js', 'text/javascript'],
    ['ort-wasm-simd-threaded.mjs', 'text/javascript'],
    ['ort-wasm-simd-threaded.wasm', 'application/wasm']
  ])('serves %s as %s, with Vite\'s ?import and under any base', (name, type) => {
    for (const url of [`/${assets.dir}/${name}`, `/${assets.dir}/${name}?import`, `/some/base/${assets.dir}/${name}`]) {
      const res = ask(url)
      expect(res.statusCode, url).toBe(200)
      expect(res.headers['Content-Type']).toBe(type)
      expect(res.body.length).toBe(bytesOf(name).length)
    }
    expect(ask(`/${assets.dir}/${name}`, 'HEAD').body).toBeUndefined()
  })

  it('answers 404, not the app, for a file it does not have', () => {
    for (const url of [`/${assets.dir}/ort-wasm-simd-threaded.jsep.mjs`, '/assets/vad/000000000000/silero_vad_v5.onnx']) {
      const res = ask(url)
      expect(res.statusCode, url).toBe(404)
      expect(res.passed).toBe(false)
    }
  })

  it('leaves every other request alone', () => {
    for (const url of ['/', '/assets/avatars/a.glb', '/silero_vad_v5.onnx', `/?next=/${assets.dir}/x`]) expect(ask(url).passed, url).toBe(true)
  })
})

describe('the hosts', () => {
  it('answer 404 under /assets/ on Cloudflare Pages, and keep the single-page app elsewhere', () => {
    expect(existsSync(path.join(root, 'apps/web/public/assets/404.html'))).toBe(true)
    // A top-level 404.html would end the app's fallback for every route.
    expect(existsSync(path.join(root, 'apps/web/public/404.html'))).toBe(false)
  })

  it('give the .mjs a JavaScript type in the container, and a missing asset a 404', () => {
    const assetsBlock = /location \/assets\/ \{[\s\S]*?\n {4}\}/.exec(read('nginx/default.conf'))?.[0]
    expect(assetsBlock).toContain('try_files $uri =404;')
    expect(assetsBlock).toMatch(/location ~ \\\.mjs\$ \{\n\s+default_type text\/javascript;/)
  })
})
