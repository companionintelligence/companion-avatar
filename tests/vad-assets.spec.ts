import { test, expect } from '@playwright/test'

/**
 * Voice input starts: turning the microphone on initialises MicVAD from the files the build ships
 * (scripts/vite-vad-assets.mjs). Needs no LLM server. Runs with the default config, against the dev
 * server or, with E2E_SERVER=preview, a production build:
 *
 *   pnpm exec playwright test tests/vad-assets.spec.ts --project chromium
 */
test('turning the microphone on starts the voice-activity detector with its own files', async ({ page }) => {
  const answers: { file: string; status: number; type: string }[] = []
  page.on('response', (response) => {
    const file = /\/assets\/vad\/[0-9a-f]{12}\/([^/?]+)/.exec(response.url())?.[1]
    if (file) answers.push({ file, status: response.status(), type: response.headers()['content-type'] ?? '' })
  })
  const failures: string[] = []
  page.on('console', (message) => {
    if (message.text().includes('Failed to initialize VAD')) failures.push(message.text())
  })

  await page.goto('/')
  await page.getByText('Enable Mic').click({ timeout: 60_000 })

  // The status pill says "Listening" only once MicVAD.new has resolved: the worklet, the model and
  // onnxruntime loaded. The open control panel hides the pill, so it is read, not looked at. (The
  // mic button's tooltip follows the toggle, not the detector, and would pass without it.)
  await expect(page.locator('[role="status"][aria-label="Listening"]')).toBeAttached({ timeout: 45_000 })
  expect(failures).toEqual([])

  // Chromium does not report an audio worklet's own fetch, so the worklet is not in this list;
  // MicVAD.new could not have resolved without it.
  expect([...new Set(answers.map((answer) => answer.file))]).toEqual(
    expect.arrayContaining(['silero_vad_v5.onnx', 'ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm'])
  )
  for (const answer of answers) {
    expect(answer.status, answer.file).toBe(200)
    expect(answer.type, answer.file).not.toContain('text/html')
  }
})
