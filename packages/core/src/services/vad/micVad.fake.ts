/**
 * A stand-in for `MicVAD` (`@ricky0123/vad-web` 0.0.30) in tests. It keeps the library's own rules,
 * the ones that make its life cycle easy to get wrong:
 *
 *   - `pause()` does nothing until the first `start()` has finished;
 *   - `start()` on a paused detector counts as listening before it has the new stream;
 *   - `destroy()` throws on a detector that never opened the microphone.
 */
import type { MicStreamHooks } from './micVadController'

export interface FakeTrack {
  readyState: 'live' | 'ended'
  stop: () => void
}

export const deferred = <T = void>() => {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** Lets every pending promise run. */
export const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

export const createFakeMicrophone = () => {
  const tracks: FakeTrack[] = []
  /** Set to hold back the next getUserMedia answers, as a permission prompt does. */
  const gate: { open: Promise<void> | null } = { open: null }
  const openStream = async () => {
    await gate.open
    const track: FakeTrack = {
      readyState: 'live',
      stop: () => {
        track.readyState = 'ended'
      }
    }
    tracks.push(track)
    return { getTracks: () => [track] } as unknown as MediaStream
  }
  const live = () => tracks.filter((track) => track.readyState === 'live').length
  return { tracks, gate, openStream, live }
}

export const createFakeVad = (streams: MicStreamHooks) => {
  let initialized = false
  let stream: MediaStream | null = null
  const vad = {
    listening: false,
    destroyed: false,
    starts: 0,
    /** Set to hold the first start after it has the stream, as the worklet's download does. */
    worklet: null as Promise<void> | null,
    start: async () => {
      vad.starts += 1
      if (!initialized) {
        stream = await streams.getStream()
        await vad.worklet
        vad.listening = true
        initialized = true
        return
      }
      if (vad.listening) return
      vad.listening = true
      stream = await streams.resumeStream()
    },
    pause: async () => {
      if (!vad.listening) return
      vad.listening = false
      await streams.pauseStream(stream!)
    },
    destroy: async () => {
      vad.destroyed = true
      if (!stream) throw new Error('MicVAD has null stream, audio context, or processor adapter')
      await vad.pause()
    }
  }
  return vad
}

export type FakeVad = ReturnType<typeof createFakeVad>
