/**
 * One voice-activity detector and the microphone it holds, driven by a single question: is the mic
 * wanted?
 *
 * `MicVAD` (`@ricky0123/vad-web`) needs care here. Loading it takes seconds, `pause()` does nothing
 * while `start()` is still running, and resuming opens a new stream after an await. So:
 *
 *   - there is one detector, and one load of it in flight, however often start is asked for;
 *   - it is loaded without opening the microphone, which happens only if the mic is still wanted then;
 *   - `start()` and `pause()` run one at a time, and the last request wins;
 *   - every track it opens is kept here and stopped the moment the mic is no longer wanted, without
 *     waiting for the library.
 */

export interface MicVADInstance {
  start: () => void | Promise<void>
  pause: () => void | Promise<void>
  destroy?: () => void | Promise<void>
}

/** The `MicVAD.new` options through which the library opens and closes the microphone. */
export interface MicStreamHooks {
  getStream: () => Promise<MediaStream>
  pauseStream: (stream: MediaStream) => Promise<void>
  resumeStream: () => Promise<MediaStream>
}

export interface MicVADControllerOptions {
  /** Loads a detector that has not opened the microphone (`startOnLoad: false`), using these hooks. */
  load: (streams: MicStreamHooks) => Promise<MicVADInstance>
  /** Opens the microphone. The default asks for what vad-web asks for itself. */
  openStream?: () => Promise<MediaStream>
  onListeningChange?: (listening: boolean) => void
  onError?: (message: string, error: unknown) => void
  /** The mic was wanted and the detector failed to load or start, so it is no longer wanted. */
  onUnavailable?: (error: unknown) => void
}

export interface MicVADController {
  /** Loads the detector without opening the microphone. */
  load: () => Promise<void>
  start: () => Promise<void>
  stop: () => Promise<void>
  /** Stops and destroys the detector, including one that is still loading. A later start loads anew. */
  release: () => Promise<void>
  /** Whether the mic is wanted now. Events the detector raises when it is not are to be ignored. */
  isWanted: () => boolean
}

const openMicrophone = () =>
  navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, autoGainControl: true, noiseSuppression: true }
  })

export const createMicVADController = ({
  load,
  openStream = openMicrophone,
  onListeningChange,
  onError = (message, error) => console.error(message, error),
  onUnavailable
}: MicVADControllerOptions): MicVADController => {
  let wanted = false
  let released = false
  let instance: MicVADInstance | null = null
  let loading: Promise<MicVADInstance | null> | null = null
  let loadError: unknown
  /** The library has been started and not paused since. */
  let capturing = false
  /** A track was stopped under the library, so it has to be paused before it can listen again. */
  let interrupted = false
  let running: Promise<void> | null = null
  const tracks = new Set<MediaStreamTrack>()

  const stopTracks = () => {
    if (!wanted && tracks.size) interrupted = true
    for (const track of tracks) track.stop()
    tracks.clear()
  }

  const open = async () => {
    const stream = await openStream()
    for (const track of stream.getTracks()) tracks.add(track)
    // Turned off while the browser was opening it (a permission prompt can stay up for a long time).
    if (!wanted) stopTracks()
    return stream
  }

  const streams: MicStreamHooks = {
    getStream: open,
    resumeStream: open,
    pauseStream: async (stream) => {
      for (const track of stream.getTracks()) {
        track.stop()
        tracks.delete(track)
      }
    }
  }

  const destroy = async (vad: MicVADInstance) => {
    try {
      await vad.destroy?.()
    } catch {
      // vad-web's destroy() throws on a detector that never opened the microphone: no microphone to close.
    }
  }

  const discard = async () => {
    const vad = instance
    instance = null
    capturing = false
    stopTracks()
    if (vad) await destroy(vad)
  }

  const ensureLoaded = (): Promise<MicVADInstance | null> => {
    if (instance) return Promise.resolve(instance)
    loading ??= load(streams).then(
      async (vad) => {
        loading = null
        if (released) {
          await destroy(vad)
          return null
        }
        instance = vad
        return vad
      },
      (error: unknown) => {
        loading = null
        loadError = error
        onError('Failed to initialize VAD:', error)
        return null
      }
    )
    return loading
  }

  /** Stops wanting a mic that cannot be had, and says so if it was still wanted. */
  const giveUp = (error: unknown) => {
    if (!wanted) return
    wanted = false
    onUnavailable?.(error)
  }

  const startStep = async () => {
    const vad = await ensureLoaded()
    if (!vad) {
      // It could not load. Wait to be asked again rather than retrying in a loop.
      giveUp(loadError)
      return
    }
    if (!wanted) return
    interrupted = false
    try {
      await vad.start()
    } catch (error) {
      // vad-web cannot start a detector again after its start failed.
      onError('Failed to start VAD:', error)
      giveUp(error)
      await discard()
      return
    }
    capturing = true
    if (wanted && !interrupted) onListeningChange?.(true)
  }

  const pauseStep = async () => {
    capturing = false
    interrupted = false
    try {
      await instance?.pause()
    } catch (error) {
      onError('Failed to stop VAD:', error)
      await discard()
    }
  }

  /** What has to happen next for the detector to match what is wanted, or null when it does. */
  const nextStep = () => {
    if (capturing && (!wanted || interrupted)) return pauseStep
    if (wanted && !capturing) return startStep
    if (released && instance) return discard
    return null
  }

  const settle = (): Promise<void> => {
    if (running) return running
    let done = () => {}
    running = new Promise<void>((resolve) => (done = resolve))
    const current = running
    void (async () => {
      try {
        for (let step = nextStep(); step; step = nextStep()) await step()
      } finally {
        // No await between the last nextStep() and here, so no request can slip in unseen.
        running = null
        done()
      }
    })()
    return current
  }

  const stop = () => {
    wanted = false
    stopTracks()
    onListeningChange?.(false)
    return settle()
  }

  return {
    load: async () => {
      released = false
      await ensureLoaded()
    },
    start: () => {
      released = false
      wanted = true
      return settle()
    },
    stop,
    release: () => {
      released = true
      return stop()
    },
    isWanted: () => wanted
  }
}
