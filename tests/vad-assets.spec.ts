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
    if (/Failed to (initialize|start) VAD/.test(message.text())) failures.push(message.text())
  })

  await page.goto('/')
  await page.getByText('Enable Mic').click({ timeout: 60_000 })

  // The status pill says "Listening" only once the detector's start() has resolved: the worklet, the model and
  // onnxruntime loaded. The open control panel hides the pill, so it is read, not looked at. (The
  // mic button's tooltip follows the toggle, not the detector, and would pass without it.)
  await expect(page.locator('[role="status"][aria-label="Listening"]')).toBeAttached({ timeout: 45_000 })
  expect(failures).toEqual([])

  // Chromium does not report an audio worklet's own fetch, so the worklet is not in this list;
  // start() could not have resolved without it.
  expect([...new Set(answers.map((answer) => answer.file))]).toEqual(
    expect.arrayContaining(['silero_vad_v5.onnx', 'ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm'])
  )
  for (const answer of answers) {
    expect(answer.status, answer.file).toBe(200)
    expect(answer.type, answer.file).not.toContain('text/html')
  }
})

/**
 * The microphone is off when the app says it is off, also when it was turned off and on while the
 * detector was still loading. Every track the page ever got from getUserMedia is kept and counted.
 * The model is held back until the test lets it go, so the taps land inside the load.
 */
type MicWindow = Window & { __micTracks: MediaStreamTrack[]; __recognitionStarts: number }

const recordMicrophone = () => {
  const w = window as unknown as MicWindow
  w.__micTracks = []
  w.__recognitionStarts = 0
  const getUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
  navigator.mediaDevices.getUserMedia = async (constraints) => {
    const stream = await getUserMedia(constraints)
    w.__micTracks.push(...stream.getAudioTracks())
    return stream
  }
  const speech = (window as unknown as { webkitSpeechRecognition?: { prototype: { start: () => void } } })
    .webkitSpeechRecognition
  if (speech) {
    const start = speech.prototype.start
    speech.prototype.start = function (this: unknown) {
      w.__recognitionStarts += 1
      start.call(this)
    }
  }
}

test('turning the microphone off leaves no track live, also after taps while the detector loads', async ({ page }) => {
  await page.addInitScript(recordMicrophone)
  let letModelThrough = () => {}
  const held = new Promise<void>((resolve) => (letModelThrough = resolve))
  let modelRequests = 0
  await page.route('**/assets/vad/**/silero_vad_v5.onnx', async (route) => {
    modelRequests += 1
    await held
    await route.continue()
  })
  let speechStarts = 0
  page.on('console', (message) => {
    if (message.text().includes('Speech started')) speechStarts += 1
  })
  const liveTracks = () =>
    page.evaluate(() => (window as unknown as MicWindow).__micTracks.filter((t) => t.readyState === 'live').length)
  // The button's name follows the toggle and, while someone is speaking, the detector.
  const mic = page.getByRole('button', { name: /^(Mic|Mic on|Listening)$/ })
  const listening = page.locator('[role="status"][aria-label="Listening"]')

  // Each tap is waited for: a busy page (the avatar still loading) can miss one, which would turn "off" into "on".
  const tapTo = async (on: boolean) => {
    await mic.click()
    await expect(mic).toHaveAttribute('aria-pressed', String(on), { timeout: 15_000 })
  }

  await page.goto('/')
  await page.getByText('Enable Mic').click({ timeout: 60_000 })
  await expect.poll(() => modelRequests, { timeout: 45_000 }).toBeGreaterThan(0)

  // Off and on again, the controls hidden and shown (each a re-render), then off: all mid-load.
  await tapTo(false)
  await tapTo(true)
  await page.getByRole('button', { name: 'Hide Controls' }).click()
  await page.getByRole('button', { name: 'Show Controls' }).click()
  await tapTo(false)
  letModelThrough()

  // Long enough for every pending load to finish and, if the app let it, to open the microphone.
  await page.waitForTimeout(8_000)
  expect(modelRequests, 'one detector is loaded, however often the app renders').toBe(1)
  expect(await liveTracks(), 'live microphone tracks with the mic off').toBe(0)

  // The same detector then starts and stops with the button.
  await mic.click()
  await expect(listening).toBeAttached({ timeout: 45_000 })
  await expect.poll(liveTracks).toBe(1)
  await mic.click()
  await expect.poll(liveTracks).toBe(0)

  // Quick taps on the loaded detector. The mic must follow what the button then says; then it is turned off.
  for (let tap = 0; tap < 6; tap += 1) await mic.click()
  await page.waitForTimeout(1_000)
  const on = (await mic.getAttribute('aria-pressed')) === 'true'
  expect(await liveTracks(), 'live microphone tracks after quick taps').toBe(on ? 1 : 0)
  if (on) await tapTo(false)
  await page.waitForTimeout(1_000)
  const after = await page.evaluate(() => (window as unknown as MicWindow).__recognitionStarts)
  speechStarts = 0
  await page.waitForTimeout(5_000)
  expect(await liveTracks(), 'live microphone tracks after quick taps').toBe(0)
  expect(speechStarts, 'speech events with the mic off').toBe(0)
  expect(await page.evaluate(() => (window as unknown as MicWindow).__recognitionStarts), 'speech recognition starts with the mic off').toBe(after)
  expect(modelRequests).toBe(1)
})

/** A refused mic leaves the setting off, so the Mic button does not read on with nothing listening. */
test('a microphone the browser then refuses leaves the Mic button off', async ({ page }) => {
  // The first request is Enable Mic's own permission check. The detector's, which follows, is refused.
  await page.addInitScript(() => {
    const getUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
    let requests = 0
    navigator.mediaDevices.getUserMedia = (constraints) =>
      ++requests === 1
        ? getUserMedia(constraints)
        : Promise.reject(new DOMException('Permission denied', 'NotAllowedError'))
  })
  const refused: string[] = []
  page.on('console', (message) => {
    if (message.text().includes('Failed to start VAD')) refused.push(message.text())
  })

  await page.goto('/')
  await page.getByText('Enable Mic').click({ timeout: 60_000 })

  await expect.poll(() => refused.length, { timeout: 45_000 }).toBe(1)
  await expect(page.getByRole('button', { name: 'Mic', exact: true })).toBeVisible()
  // Off, and not tried again on its own.
  await page.waitForTimeout(2_000)
  expect(refused).toHaveLength(1)
})
