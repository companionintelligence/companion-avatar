import { describe, expect, it, vi } from 'vitest'

import { createFakeMicrophone, createFakeVad, deferred, flush, type FakeVad } from './micVad.fake'
import { createMicVADController, type MicStreamHooks } from './micVadController'

/** A controller whose loads are resolved by hand. */
const setup = () => {
  const mic = createFakeMicrophone()
  const loads: { vad: FakeVad; finish: () => void; fail: (error: Error) => void }[] = []
  const load = vi.fn((streams: MicStreamHooks) => {
    const pending = deferred<FakeVad>()
    const vad = createFakeVad(streams)
    loads.push({ vad, finish: () => pending.resolve(vad), fail: pending.reject })
    return pending.promise
  })
  const onListeningChange = vi.fn()
  const onError = vi.fn()
  const controller = createMicVADController({ load, openStream: mic.openStream, onListeningChange, onError })
  const listening = () => onListeningChange.mock.lastCall?.[0] ?? false
  return { mic, load, loads, controller, listening, onError }
}

/** Loaded and listening. */
const running = async () => {
  const t = setup()
  void t.controller.start()
  t.loads[0].finish()
  await flush()
  return t
}

describe('createMicVADController', () => {
  it('loads one detector and opens one stream however often start is asked for', async () => {
    const t = setup()
    for (let i = 0; i < 5; i += 1) void t.controller.start()
    void t.controller.load()
    t.loads[0].finish()
    await flush()
    void t.controller.start()
    await flush()
    expect(t.load).toHaveBeenCalledTimes(1)
    expect(t.mic.tracks).toHaveLength(1)
    expect(t.mic.live()).toBe(1)
    expect(t.listening()).toBe(true)
  })

  it('loads without opening the microphone', async () => {
    const t = setup()
    void t.controller.load()
    t.loads[0].finish()
    await flush()
    expect(t.mic.tracks).toHaveLength(0)
    expect(t.loads[0].vad.starts).toBe(0)
  })

  it('never opens the microphone when it was turned off during the load, and keeps the detector', async () => {
    const t = setup()
    void t.controller.start()
    void t.controller.stop()
    void t.controller.start()
    void t.controller.stop()
    t.loads[0].finish()
    await flush()
    expect(t.mic.tracks).toHaveLength(0)
    expect(t.listening()).toBe(false)

    void t.controller.start()
    await flush()
    expect(t.load).toHaveBeenCalledTimes(1)
    expect(t.mic.live()).toBe(1)
  })

  it('stops the stream the browser hands over after the mic was turned off', async () => {
    const t = setup()
    const prompt = deferred()
    t.mic.gate.open = prompt.promise
    void t.controller.start()
    t.loads[0].finish()
    await flush()
    void t.controller.stop()
    prompt.resolve()
    await flush()
    expect(t.mic.tracks).toHaveLength(1)
    expect(t.mic.live()).toBe(0)
    expect(t.loads[0].vad.listening).toBe(false)
    expect(t.listening()).toBe(false)
  })

  it('stops the track at once while start() is still running, when pause() would do nothing', async () => {
    const t = setup()
    const worklet = deferred()
    void t.controller.start()
    t.loads[0].vad.worklet = worklet.promise
    t.loads[0].finish()
    await flush()
    expect(t.mic.live()).toBe(1)
    void t.controller.stop()
    expect(t.mic.live()).toBe(0)
    worklet.resolve()
    await flush()
    expect(t.loads[0].vad.listening).toBe(false)
    expect(t.listening()).toBe(false)
  })

  it('opens a new stream when the mic is turned on again before start() has finished', async () => {
    const t = setup()
    const worklet = deferred()
    void t.controller.start()
    t.loads[0].vad.worklet = worklet.promise
    t.loads[0].finish()
    await flush()
    void t.controller.stop()
    void t.controller.start()
    worklet.resolve()
    await flush()
    expect(t.mic.tracks).toHaveLength(2)
    expect(t.mic.live()).toBe(1)
    expect(t.loads[0].vad.listening).toBe(true)
    expect(t.listening()).toBe(true)
  })

  it('leaves no track live after quick taps while a resumed stream is still opening', async () => {
    const t = await running()
    void t.controller.stop()
    await flush()
    const opening = deferred()
    t.mic.gate.open = opening.promise
    void t.controller.start()
    void t.controller.stop()
    void t.controller.start()
    void t.controller.stop()
    opening.resolve()
    await flush()
    expect(t.mic.live()).toBe(0)
    expect(t.loads[0].vad.listening).toBe(false)
    expect(t.controller.isWanted()).toBe(false)
  })

  it('listens on one stream after quick taps that end on', async () => {
    const t = await running()
    void t.controller.stop()
    void t.controller.start()
    void t.controller.stop()
    void t.controller.start()
    await flush()
    expect(t.mic.live()).toBe(1)
    expect(t.loads[0].vad.listening).toBe(true)
    expect(t.listening()).toBe(true)
  })

  it('does not retry a failed load on its own, and loads again when asked', async () => {
    const t = setup()
    void t.controller.start()
    t.loads[0].fail(new Error('text/html'))
    await flush()
    expect(t.load).toHaveBeenCalledTimes(1)
    expect(t.mic.tracks).toHaveLength(0)
    expect(t.onError).toHaveBeenCalledWith('Failed to initialize VAD:', expect.any(Error))

    void t.controller.start()
    expect(t.load).toHaveBeenCalledTimes(2)
  })

  it('closes the stream of a detector whose start failed, and replaces that detector', async () => {
    const t = setup()
    const worklet = deferred()
    void t.controller.start()
    t.loads[0].vad.worklet = worklet.promise
    t.loads[0].finish()
    await flush()
    worklet.reject(new Error('no worklet'))
    await flush()
    expect(t.mic.live()).toBe(0)
    expect(t.loads[0].vad.destroyed).toBe(true)
    expect(t.onError).toHaveBeenCalledWith('Failed to start VAD:', expect.any(Error))

    void t.controller.start()
    expect(t.load).toHaveBeenCalledTimes(2)
  })

  it('release() stops the stream and destroys the detector', async () => {
    const t = await running()
    void t.controller.release()
    await flush()
    expect(t.mic.live()).toBe(0)
    expect(t.loads[0].vad.destroyed).toBe(true)
  })

  it('release() during the load destroys the detector when it arrives', async () => {
    const t = setup()
    void t.controller.start()
    void t.controller.release()
    t.loads[0].finish()
    await flush()
    expect(t.loads[0].vad.destroyed).toBe(true)
    expect(t.mic.tracks).toHaveLength(0)
  })

  it('keeps the load in flight when started again right after release() (React StrictMode)', async () => {
    const t = setup()
    void t.controller.start()
    void t.controller.release()
    void t.controller.start()
    t.loads[0].finish()
    await flush()
    expect(t.load).toHaveBeenCalledTimes(1)
    expect(t.loads[0].vad.destroyed).toBe(false)
    expect(t.mic.live()).toBe(1)
  })
})
