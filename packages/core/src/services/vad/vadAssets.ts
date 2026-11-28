/**
 * Where MicVAD finds its audio worklet, model and onnxruntime files.
 *
 * `@ricky0123/vad-web` defaults both paths to "./", beside the page, where no build puts them.
 * The apps' Vite plugin (scripts/vite-vad-assets.mjs) ships the files from the installed packages
 * into one folder under the app's base URL and defines `__CI_AVATAR_VAD_DIR__` as that folder.
 */

declare const __CI_AVATAR_VAD_DIR__: string | undefined

const shippedDir = (): string | undefined =>
  typeof __CI_AVATAR_VAD_DIR__ === 'string' ? __CI_AVATAR_VAD_DIR__ : undefined

export interface VADAssetPaths {
  /** The worklet and the model are fetched from here. */
  baseAssetPath: string
  /** onnxruntime's .mjs loader and .wasm are fetched from here. */
  onnxWASMBasePath: string
}

/**
 * The options to spread into `MicVAD.new`. Both are one absolute URL: onnxruntime imports its loader
 * from this path, and a relative one would resolve against the script's folder, not the page's.
 */
export const vadAssetPaths = (
  dir = shippedDir(),
  base: string = import.meta.env.BASE_URL,
  pageUrl: string = document.baseURI
): VADAssetPaths => {
  if (!dir) {
    throw new Error('This build ships no voice-activity files: its Vite config needs vadAssets() from scripts/vite-vad-assets.mjs')
  }
  const url = new URL(`${base}${dir}`, pageUrl).href
  return { baseAssetPath: url, onnxWASMBasePath: url }
}
