import { describe, expect, it } from 'vitest'

import { vadAssetPaths } from './vadAssets'

const DIR = 'assets/vad/0123456789ab/'

describe('vadAssetPaths', () => {
  it('is one absolute folder under the base, for the model, the worklet and onnxruntime', () => {
    const url = `https://avatar.ci.computer/${DIR}`
    expect(vadAssetPaths(DIR, '/', 'https://avatar.ci.computer/')).toEqual({ baseAssetPath: url, onnxWASMBasePath: url })
  })

  it('does not move with the page address', () => {
    expect(vadAssetPaths(DIR, '/', 'https://avatar.ci.computer/a/b?env=datacenter-1970s').baseAssetPath).toBe(
      `https://avatar.ci.computer/${DIR}`
    )
  })

  it('follows the app base: a sub-path, a relative base and a native shell', () => {
    expect(vadAssetPaths(DIR, '/apps/avatar/', 'https://hub.example/apps/avatar/').baseAssetPath).toBe(
      `https://hub.example/apps/avatar/${DIR}`
    )
    expect(vadAssetPaths(DIR, './', 'https://hub.example/apps/avatar/').baseAssetPath).toBe(`https://hub.example/apps/avatar/${DIR}`)
    expect(vadAssetPaths(DIR, '/', 'capacitor://localhost/').baseAssetPath).toBe(`capacitor://localhost/${DIR}`)
    expect(vadAssetPaths(DIR, '/', 'tauri://localhost/').baseAssetPath).toBe(`tauri://localhost/${DIR}`)
  })

  it('says what is missing when a build did not ship the files, rather than asking beside the page', () => {
    expect(() => vadAssetPaths(undefined, '/', 'https://avatar.ci.computer/')).toThrow(/vadAssets\(\)/)
  })
})
