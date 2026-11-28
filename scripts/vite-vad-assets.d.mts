// Types for scripts/vite-vad-assets.mjs, which is plain JavaScript so that `vite build` (the apps' vite.config.ts) and `node` can both run it.
// The Plugin type is structural: apps/web and apps/vision-pro are on different major versions of Vite.

export const VAD_DIR: string
export const VAD_MANIFEST: string
export const VAD_LICENSES: string
export const VAD_DEFINE: string
export const VAD_FILES: { name: string; from: 'vad-web' | 'onnxruntime-web' }[]

export interface VadAssets {
  /** The folder in the build output, relative to the app's base, with no trailing slash. */
  dir: string
  files: { name: string; bytes: Uint8Array }[]
  versions: Record<string, string>
}

/** The files as installed under `root` (default: this repository). */
export function readVadAssets(root?: string): VadAssets

/** The text of vad-assets.json. */
export function vadManifest(assets: VadAssets): string

/** The dev server's handler for /assets/vad/. */
export function vadMiddleware(assets: VadAssets): (req: unknown, res: unknown, next: () => void) => void

/** The Vite plugin. */
export function vadAssets(): {
  name: string
  config(): { define: Record<string, string> }
  configResolved(config: { build: { ssr?: unknown } }): void
  configureServer(server: { middlewares: { use(handler: (...args: never[]) => unknown): unknown } }): void
  generateBundle(): void
}
