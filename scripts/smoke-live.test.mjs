import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { DEFAULT_SETTLE_MS, DEFAULT_TIMEOUT_MS, DEFAULT_URL, allowRule, checkVadAssets, originOf, parseArgs, sortRequests } from './smoke-live.mjs'
import { VAD_MANIFEST, readVadAssets, vadManifest } from './vite-vad-assets.mjs'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (relative) => readFileSync(path.join(root, relative), 'utf8')

// The browser half of the check needs a deployed page; these cover the part that decides what counts as the
// page's own origin, which is where a mistake would let a third-party request through unnoticed.

describe('originOf', () => {
  it('is the scheme, host and port a request reaches', () => {
    expect(originOf('https://avatar.ci.computer/assets/index-abc.js?x=1#y')).toBe('https://avatar.ci.computer')
    expect(originOf('http://localhost:4173/')).toBe('http://localhost:4173')
    expect(originOf('https://Example.COM:443/a')).toBe('https://example.com')
  })

  it('counts a socket to a host as that host', () => {
    expect(originOf('wss://avatar.ci.computer/live')).toBe('https://avatar.ci.computer')
    expect(originOf('ws://localhost:4173/')).toBe('http://localhost:4173')
  })

  it('is null for what reaches no server', () => {
    for (const url of ['data:text/plain,hi', 'blob:https://avatar.ci.computer/0b1c', 'about:blank', 'chrome-extension://abc/x.js', 'not a url']) {
      expect(originOf(url)).toBeNull()
    }
  })
})

describe('allowRule', () => {
  it('takes an origin, and only that origin', () => {
    const rule = allowRule('https://arweave.net')
    expect(rule.matches('https://arweave.net')).toBe(true)
    expect(rule.matches('https://x.arweave.net')).toBe(false)
    expect(rule.matches('http://arweave.net')).toBe(false)
    expect(allowRule('https://arweave.net/').matches('https://arweave.net')).toBe(true)
  })

  it('takes a host and every host under it with *.', () => {
    const rule = allowRule('https://*.arweave.net')
    expect(rule.matches('https://arweave.net')).toBe(true)
    expect(rule.matches('https://abc123.arweave.net')).toBe(true)
    expect(rule.matches('https://a.b.arweave.net')).toBe(true)
    expect(rule.matches('https://evilarweave.net')).toBe(false)
    expect(rule.matches('https://arweave.net.example.com')).toBe(false)
    expect(rule.matches('http://abc123.arweave.net')).toBe(false)
  })

  it('refuses what is not an origin', () => {
    for (const entry of ['arweave.net', 'https://arweave.net/some/path', 'ftp://example.com', '*', 'https://*']) {
      expect(() => allowRule(entry)).toThrow(/--allow takes an origin/)
    }
  })
})

describe('sortRequests', () => {
  const own = ['https://avatar.ci.computer', 'https://avatar.ci.computer/']
  const get = (url) => ({ method: 'GET', url, type: 'fetch' })

  it('counts the page\'s own requests and lists every other one', () => {
    const { sameOrigin, allowed, thirdParty } = sortRequests(
      [
        get('https://avatar.ci.computer/'),
        get('https://avatar.ci.computer/assets/environments/studio_small_03_1k.hdr'),
        get('data:image/png;base64,AAAA'),
        get('https://raw.githack.com/pmndrs/drei-assets/hdri/studio_small_03_1k.hdr'),
        get('https://cdn.jsdelivr.net/npm/@diffusionstudio/vits-web@1.0.3/+esm')
      ],
      own
    )
    expect(sameOrigin).toBe(2)
    expect(allowed).toEqual([])
    expect(thirdParty.map((r) => r.origin)).toEqual(['https://raw.githack.com', 'https://cdn.jsdelivr.net'])
  })

  it('lets the allowlist through, and nothing else', () => {
    const { allowed, thirdParty } = sortRequests(
      [get('https://arweave.net/gfVz'), get('https://abc.arweave.net/gfVz'), get('https://unpkg.com/x')],
      own,
      [allowRule('https://*.arweave.net')]
    )
    expect(allowed.map((r) => r.origin)).toEqual(['https://arweave.net', 'https://abc.arweave.net'])
    expect(thirdParty.map((r) => r.origin)).toEqual(['https://unpkg.com'])
  })

  it('treats the origin a redirect lands on as the page\'s own', () => {
    const { sameOrigin, thirdParty } = sortRequests(
      [get('https://avatars-zbe.pages.dev/'), get('https://avatar.ci.computer/assets/a.js')],
      ['https://avatars-zbe.pages.dev', 'https://avatar.ci.computer/']
    )
    expect(sameOrigin).toBe(2)
    expect(thirdParty).toEqual([])
  })
})

describe('checkVadAssets', () => {
  const site = 'https://avatar.ci.computer/'
  const assets = readVadAssets()
  const types = { js: 'application/javascript', mjs: 'application/javascript', wasm: 'application/wasm', json: 'application/json' }
  const typeOf = (url) => types[url.split('.').pop()] ?? 'application/octet-stream'
  const answer = (type, { status = 200, url, body } = {}) => ({ status, url, headers: new Headers({ 'content-type': type }), json: async () => JSON.parse(body) })
  /** A host serving this build, with `broken` replacing its answers for some paths. */
  const host = (broken = {}) => {
    const asked = []
    const fetchImpl = async (url, init) => {
      asked.push(`${init?.method ?? 'GET'} ${url}`)
      const name = url.split('/').pop()
      return broken[name] ?? answer(typeOf(url), { url, body: name === VAD_MANIFEST ? vadManifest(assets) : undefined })
    }
    return { asked, fetchImpl }
  }
  // What Cloudflare Pages answered for every one of these files before they shipped.
  const spaFallback = answer('text/html; charset=utf-8', { body: '<!doctype html>' })

  it('passes a deploy that serves every file the detector asks for, by HEAD', async () => {
    const { asked, fetchImpl } = host()
    const { urls, problems } = await checkVadAssets(`${site}?env=datacenter-1970s`, fetchImpl)
    expect(problems).toEqual([])
    expect(urls).toContain(`${site}${assets.dir}/silero_vad_v5.onnx`)
    expect(asked[0]).toBe(`GET ${site}${VAD_MANIFEST}`)
    expect(asked.slice(1).every((line) => line.startsWith('HEAD '))).toBe(true)
    expect(asked).toHaveLength(1 + assets.files.length)
  })

  it.each(['silero_vad_v5.onnx', 'vad.worklet.bundle.min.js', 'ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm'])(
    'fails when %s comes back as a web page',
    async (name) => {
      const { problems } = await checkVadAssets(site, host({ [name]: spaFallback }).fetchImpl)
      expect(problems).toHaveLength(1)
      expect(problems[0]).toContain(`${name} is a web page`)
    }
  )

  it('fails a deploy with no list, which is one that shipped no files', async () => {
    const { problems } = await checkVadAssets(site, host({ [VAD_MANIFEST]: spaFallback }).fetchImpl)
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain(`${VAD_MANIFEST} is a web page`)
  })

  it('fails a list that leaves a file out, is empty or is not a list', async () => {
    for (const body of ['{"files":[]}', '{}', 'nonsense']) {
      const { problems } = await checkVadAssets(site, host({ [VAD_MANIFEST]: answer('application/json', { body }) }).fetchImpl)
      expect(problems.length, body).toBeGreaterThan(0)
    }
  })

  it('fails a missing file, a wrong type and an answer from another origin', async () => {
    const broken = {
      'silero_vad_v5.onnx': answer('text/plain', { status: 404 }),
      'ort-wasm-simd-threaded.mjs': answer('application/octet-stream'),
      'ort-wasm-simd-threaded.wasm': answer('application/octet-stream'),
      'vad.worklet.bundle.min.js': answer('application/javascript', { url: 'https://cdn.jsdelivr.net/vad.worklet.bundle.min.js' })
    }
    const { problems } = await checkVadAssets(site, host(broken).fetchImpl)
    expect(problems.join('\n')).toMatch(/silero_vad_v5\.onnx answered 404/)
    expect(problems.join('\n')).toMatch(/\.mjs has the type "application\/octet-stream", not a JavaScript type/)
    expect(problems.join('\n')).toMatch(/\.wasm has the type "application\/octet-stream", not application\/wasm/)
    expect(problems.join('\n')).toMatch(/was sent on to https:\/\/cdn\.jsdelivr\.net/)
    expect(problems).toHaveLength(4)
  })
})

describe('parseArgs', () => {
  it('loads the live site with an empty allowlist by default', () => {
    const options = parseArgs([], {})
    expect(options).toMatchObject({ url: DEFAULT_URL, allow: [], settle: DEFAULT_SETTLE_MS, timeout: DEFAULT_TIMEOUT_MS })
    expect(options.rules).toEqual([])
    expect(DEFAULT_URL).toBe('https://avatar.ci.computer')
  })

  it('takes the URL and the allowlist from the environment, which the workflow sets', () => {
    const options = parseArgs([], { SMOKE_URL: ' https://fix-x.avatars-zbe.pages.dev ', SMOKE_ALLOW: 'https://*.arweave.net, ,https://models.readyplayer.me' })
    expect(options.url).toBe('https://fix-x.avatars-zbe.pages.dev')
    expect(options.allow).toEqual(['https://*.arweave.net', 'https://models.readyplayer.me'])
    expect(options.rules).toHaveLength(2)
  })

  it('treats a blank environment like an absent one', () => {
    expect(parseArgs([], { SMOKE_URL: '', SMOKE_ALLOW: '' })).toMatchObject({ url: DEFAULT_URL, allow: [] })
  })

  it('takes a URL and options on the command line, on top of the environment', () => {
    const options = parseArgs(['http://localhost:4173', '--allow', 'https://arweave.net', '--settle', '2000', '--timeout', '30000'], {
      SMOKE_ALLOW: 'https://*.arweave.net'
    })
    expect(options).toMatchObject({ url: 'http://localhost:4173', allow: ['https://*.arweave.net', 'https://arweave.net'], settle: 2000, timeout: 30000 })
  })

  it('refuses what it cannot use', () => {
    expect(() => parseArgs(['avatar.ci.computer'], {})).toThrow(/must start with http/)
    expect(() => parseArgs(['https://a.example', 'https://b.example'], {})).toThrow(/one URL at a time/)
    expect(() => parseArgs(['--settle', 'soon'], {})).toThrow(/number of milliseconds/)
    expect(() => parseArgs(['--allow'], {})).toThrow(/needs a value/)
    expect(() => parseArgs(['--block', 'x'], {})).toThrow(/unknown option/)
    expect(() => parseArgs(['--allow', 'arweave.net'], {})).toThrow(/--allow takes an origin/)
  })
})

describe('.github/workflows/smoke-live.yml', () => {
  const workflow = read('.github/workflows/smoke-live.yml')

  it('runs only when someone dispatches it, as this org\'s workflows do', () => {
    expect(workflow).toMatch(/^on:\n {2}workflow_dispatch:/m)
    expect(workflow).not.toMatch(/^ {2}(push|pull_request|schedule|workflow_run):/m)
  })

  it('runs this script through the npm script, with the inputs in the environment, never in a script', () => {
    expect(JSON.parse(read('package.json')).scripts['smoke:live']).toBe('node scripts/smoke-live.mjs')
    expect(workflow).toMatch(/^\s+run: pnpm smoke:live$/m)
    expect(workflow).toMatch(/^\s+SMOKE_URL: \$\{\{ inputs\.url \}\}$/m)
    expect(workflow).toMatch(/^\s+SMOKE_ALLOW: \$\{\{ inputs\.allow \}\}$/m)
    const scripts = [...workflow.matchAll(/^\s+run: (.*)$/gm)].map((match) => match[1]).join('\n')
    expect(scripts).not.toContain('${{')
  })

  it('defaults to the live site with an empty allowlist, like the script', () => {
    expect(workflow).toMatch(/url:\n(?:\s+\w+: .*\n)*?\s+default: https:\/\/avatar\.ci\.computer\n/)
    expect(workflow).toMatch(/allow:\n(?:\s+\w+: .*\n)*?\s+default: ''\n/)
  })

  it('pins every action to a commit', () => {
    const uses = [...workflow.matchAll(/^\s+- uses: (\S+)/gm)].map((match) => match[1])
    expect(uses.length).toBeGreaterThan(0)
    for (const action of uses) expect(action, action).toMatch(/@[0-9a-f]{40}$/)
  })
})
