import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AgentCallbacks, AgentConfig } from './useAgent'
import { createFakeMicrophone, createFakeVad, deferred, flush, type FakeVad } from './vad/micVad.fake'
import type { MicStreamHooks } from './vad/micVadController'

/**
 * What the mic setting means for voice input that is not a turn yet, through the real useAgent: turning it off
 * drops the recognizer's late result and a transcription still out; ordinary end of speech keeps them. MicVAD,
 * SpeechRecognition and the transcription request are faked, and so are the face and body services, which import
 * three (the jsdom project cannot resolve it).
 */
vi.mock('./emote/useEmoteService', () => {
  const service = { state: {}, actions: { performAction: () => {}, reset: () => {}, onBargeIn: () => {} } }
  return { useEmoteService: () => service }
})
vi.mock('./visemes/useVisemeService', () => {
  const service = { state: {}, actions: { generateSequence: () => {}, reset: () => {} } }
  return { useVisemeService: () => service }
})
vi.mock('./animation/useAnimationService', () => {
  const service = { state: {}, actions: { performAction: () => {}, clearQueue: () => {} } }
  return { useAnimationService: () => service }
})

type VADOptions = MicStreamHooks & { onSpeechStart: () => void; onSpeechEnd: (audio: Float32Array) => void }

const library = vi.hoisted(() => ({ create: vi.fn() }))
vi.mock('@ricky0123/vad-web', () => ({ MicVAD: { new: library.create } }))
vi.mock('./vad/vadAssets', () => ({ vadAssetPaths: () => ({ baseAssetPath: '/vad/', onnxWASMBasePath: '/vad/' }) }))

const transcribe = vi.hoisted(() => vi.fn())
vi.mock('./stt/remoteStt', () => ({ transcribeRemote: transcribe }))

/**
 * The browser recognizer as Chromium behaves: start() throws until the last session has ended, abort() is
 * ignored once stop() has been called, and a stopping session still returns what it heard.
 */
class FakeRecognition {
  static last: FakeRecognition
  static made = 0
  state: 'idle' | 'listening' | 'stopping' = 'idle'
  stops = 0
  aborts = 0
  onstart: (() => void) | null = null
  onend: (() => void) | null = null
  onerror: ((event: unknown) => void) | null = null
  onresult: ((event: unknown) => void) | null = null
  constructor() {
    FakeRecognition.made++
    FakeRecognition.last = this
  }
  start() {
    if (this.state !== 'idle') throw new DOMException('recognition has already started', 'InvalidStateError')
    this.state = 'listening'
    this.onstart?.()
  }
  stop() {
    this.stops++
    if (this.state === 'listening') this.state = 'stopping'
  }
  abort() {
    this.aborts++
    if (this.state === 'listening') this.end()
  }
  /** The browser returns words: possible while listening, and after stop() until the session ends. */
  deliver(text: string, isFinal = true) {
    if (this.state === 'idle') return
    this.onresult?.({ resultIndex: 0, results: [Object.assign([{ transcript: text, confidence: 1 }], { isFinal })] })
  }
  end() {
    this.state = 'idle'
    this.onend?.()
  }
}

let options: VADOptions
let useAgent: typeof import('./useAgent').useAgent

const config = (microphoneEnabled: boolean, remote = false): AgentConfig => ({
  stt: { remote, language: 'en-US', continuous: true },
  vad: { microphoneEnabled, vadEnabled: true },
  autoSubmitEnabled: true,
  bargeInEnabled: true
})

const settle = () =>
  act(async () => {
    await flush()
    await flush()
  })

async function mount(remote = false, callbacks: AgentCallbacks = {}) {
  const view = renderHook((props: AgentConfig) => useAgent(props, callbacks), { initialProps: config(true, remote) })
  await settle()
  const setMic = async (microphoneEnabled: boolean) => {
    view.rerender(config(microphoneEnabled, remote))
    await settle()
  }
  const speechStarts = async () => {
    await act(async () => options.onSpeechStart())
    await settle()
  }
  const speechEnds = async () => {
    await act(async () => options.onSpeechEnd(new Float32Array(160)))
    await settle()
  }
  return { ...view, setMic, speechStarts, speechEnds }
}

beforeEach(async () => {
  const microphone = createFakeMicrophone()
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: microphone.openStream } })
  library.create.mockReset().mockImplementation((given: VADOptions) => {
    options = given
    return Promise.resolve<FakeVad>(createFakeVad(given))
  })
  transcribe.mockReset()
  vi.stubGlobal('SpeechRecognition', FakeRecognition)
  vi.stubGlobal('fetch', () => new Promise(() => {}))
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  FakeRecognition.made = 0
  vi.resetModules()
  ;({ useAgent } = await import('./useAgent'))
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('turning the mic setting off', () => {
  /** What the browser returns after it has been told to stop listening. */
  const returns = async (text: string, isFinal = true) => {
    await act(async () => FakeRecognition.last.deliver(text, isFinal))
    await settle()
  }

  it('sends a result that arrives after ordinary end of speech', async () => {
    const agent = await mount()
    await agent.speechStarts()
    await agent.speechEnds()
    expect(FakeRecognition.last.stops).toBe(1)
    expect(FakeRecognition.last.aborts).toBe(0)
    await returns('hello there')
    expect(agent.result.current.state.messages).toHaveLength(1)
    agent.unmount()
  })

  it('aborts the recognizer when turned off while it is listening', async () => {
    const agent = await mount()
    await agent.speechStarts()
    await agent.setMic(false)
    expect(FakeRecognition.last.aborts).toBe(1)
    expect(FakeRecognition.last.state).toBe('idle')
    agent.unmount()
  })

  it('drops a result returned after the end of speech and then mic off, where abort() does nothing', async () => {
    const agent = await mount()
    await agent.speechStarts()
    await agent.speechEnds()
    await agent.setMic(false)
    expect(FakeRecognition.last.state).toBe('stopping')
    await returns('words said before mic off')
    expect(agent.result.current.state.messages).toHaveLength(0)
    agent.unmount()
  })

  it("drops what the status pill's Stop leaves behind", async () => {
    const agent = await mount()
    await agent.speechStarts()
    // What the web app's Stop does, with the mic setting going off in the same render.
    await act(async () => {
      agent.result.current.actions.stopSpeaking()
      agent.result.current.actions.stopVADListening()
      agent.result.current.actions.toggleMicrophone(false)
      agent.rerender(config(false))
    })
    await settle()
    await returns('words said before Stop')
    expect(agent.result.current.state.messages).toHaveLength(0)
    agent.unmount()
  })

  it('clears interim words, and does not bring them back when the mic is turned on again', async () => {
    const agent = await mount()
    await agent.speechStarts()
    await returns('purple interim', false)
    expect(agent.result.current.state.currentTranscript).toBe('purple interim')
    await agent.setMic(false)
    expect(agent.result.current.state.currentTranscript).toBe('')
    await agent.setMic(true)
    expect(agent.result.current.state.currentTranscript).toBe('')
    agent.unmount()
  })

  it('still hears the next thing said once the mic is back on', async () => {
    const agent = await mount()
    await agent.speechStarts()
    await agent.speechEnds()
    await agent.setMic(false)
    await act(async () => FakeRecognition.last.end())
    await agent.setMic(true)
    await agent.speechStarts()
    await returns('a new sentence')
    expect(agent.result.current.state.messages).toHaveLength(1)
    agent.unmount()
  })

  it.each([
    ['sends a transcription that arrives while the mic is still on', false, 1],
    ['drops a transcription that arrives after the mic was turned off', true, 0]
  ])('%s', async (_name, turnOff, messages) => {
    const answer = deferred<{ ok: boolean; text: string }>()
    transcribe.mockReturnValue(answer.promise)
    const agent = await mount(true)
    await agent.speechStarts()
    await agent.speechEnds()
    expect(transcribe).toHaveBeenCalledTimes(1)
    if (turnOff) await agent.setMic(false)
    await act(async () => answer.resolve({ ok: true, text: 'hello there' }))
    await settle()
    expect(agent.result.current.state.messages).toHaveLength(messages)
    agent.unmount()
  })

  it('never makes the browser recognizer with remote speech-to-text', async () => {
    transcribe.mockResolvedValue({ ok: true, text: 'hello there' })
    const agent = await mount(true)
    await agent.speechStarts()
    await agent.speechEnds()
    expect(FakeRecognition.made).toBe(0)
    expect(agent.result.current.state.messages).toHaveLength(1)
    agent.unmount()
  })

  it('says so when the mic cannot be had, so the app can turn the setting off', async () => {
    const refused = new DOMException('Permission denied', 'NotAllowedError')
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: () => Promise.reject(refused) }
    })
    const onMicUnavailable = vi.fn()
    const agent = await mount(false, { onMicUnavailable })
    expect(onMicUnavailable.mock.calls).toEqual([[refused]])
    agent.unmount()
  })
})
