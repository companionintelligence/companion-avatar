import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createFakeMicrophone, createFakeVad, deferred, flush, type FakeVad } from './micVad.fake'
import type { MicStreamHooks } from './micVadController'
import { useVADService } from './vadService'

type Options = MicStreamHooks & { startOnLoad: boolean; onSpeechStart: () => void }

const library = vi.hoisted(() => ({ create: vi.fn() }))
vi.mock('@ricky0123/vad-web', () => ({ MicVAD: { new: library.create } }))
vi.mock('./vadAssets', () => ({ vadAssetPaths: () => ({ baseAssetPath: '/vad/', onnxWASMBasePath: '/vad/' }) }))

describe('useVADService', () => {
  let mic: ReturnType<typeof createFakeMicrophone>
  let loads: { options: Options; vad: FakeVad; finish: () => void }[]

  beforeEach(() => {
    mic = createFakeMicrophone()
    loads = []
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: mic.openStream } })
    library.create.mockReset().mockImplementation((options: Options) => {
      const pending = deferred<FakeVad>()
      const vad = createFakeVad(options)
      loads.push({ options, vad, finish: () => pending.resolve(vad) })
      return pending.promise
    })
  })

  const settle = () => act(flush)

  /** Rendered as useAgent renders it: a new config object and new callbacks every time. */
  const render = () => {
    const speech = vi.fn()
    const view = renderHook(
      ({ microphoneEnabled, turn }) =>
        useVADService({
          config: { microphoneEnabled },
          onVADResult: () => {},
          onSpeechStart: () => speech(turn),
          onSpeechEnd: () => {}
        }),
      { initialProps: { microphoneEnabled: false, turn: 0 } }
    )
    let turn = 0
    const set = async (microphoneEnabled: boolean) => {
      view.rerender({ microphoneEnabled, turn: ++turn })
      await settle()
    }
    return { ...view, set, speech }
  }

  it('loads one detector, which never opens the mic if it is off when the load ends', async () => {
    const view = render()
    const { actions } = view.result.current
    await view.set(true)
    for (let i = 0; i < 4; i += 1) await view.set(true)
    await view.set(false)
    await view.set(true)
    await view.set(false)

    expect(library.create).toHaveBeenCalledTimes(1)
    expect(loads[0].options.startOnLoad).toBe(false)
    loads[0].finish()
    await settle()
    expect(mic.tracks).toHaveLength(0)
    expect(view.result.current.state.isListening).toBe(false)
    expect(view.result.current.actions).toBe(actions)
  })

  it('reports speech to the latest callback, and nothing once the mic is off', async () => {
    const view = render()
    await view.set(true)
    loads[0].finish()
    await settle()
    await view.set(true)
    expect(mic.live()).toBe(1)
    expect(view.result.current.state.isListening).toBe(true)

    act(() => loads[0].options.onSpeechStart())
    expect(view.speech.mock.calls).toEqual([[2]])
    expect(view.result.current.state.isDetecting).toBe(true)

    await view.set(false)
    expect(mic.live()).toBe(0)
    expect(view.result.current.state.isDetecting).toBe(false)
    // A frame the model was still judging raises its event after the pause.
    act(() => loads[0].options.onSpeechStart())
    expect(view.speech).toHaveBeenCalledTimes(1)
    expect(view.result.current.state.isDetecting).toBe(false)
  })

  it('stays stopped across renders after stopListening(), while the setting is still on', async () => {
    const view = render()
    await view.set(true)
    loads[0].finish()
    await settle()
    await act(() => view.result.current.actions.stopListening())
    await view.set(true)
    expect(mic.live()).toBe(0)
  })

  it('destroys the detector on unmount, including one still loading', async () => {
    const view = render()
    await view.set(true)
    view.unmount()
    loads[0].finish()
    await settle()
    expect(loads[0].vad.destroyed).toBe(true)
    expect(mic.tracks).toHaveLength(0)
  })

  it('closes the microphone on unmount', async () => {
    const view = render()
    await view.set(true)
    loads[0].finish()
    await settle()
    view.unmount()
    await flush()
    expect(mic.live()).toBe(0)
    expect(loads[0].vad.destroyed).toBe(true)
  })
})
