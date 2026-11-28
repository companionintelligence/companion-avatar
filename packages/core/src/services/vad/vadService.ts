import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createMicVADController, type MicStreamHooks } from './micVadController'
import { vadAssetPaths } from './vadAssets'
import {  defaultVadConfig, type VADConfig, type VADResult } from './vadConfig'

interface VADProbs {
  isSpeech: number
}

interface UseVADServiceProps {
  config?: Partial<VADConfig>
  onVADResult?: (result: VADResult) => void
  onSpeechStart?: () => void
  onSpeechEnd?: (audio: ArrayBuffer) => void
  /** The mic was wanted and could not be opened. Nothing is listening, and nothing retries. */
  onUnavailable?: (error: unknown) => void
}

/** Loads the detector without opening the microphone; the controller starts it when it is wanted. */
const loadMicVAD = async (
  streams: MicStreamHooks,
  handlers: {
    threshold: number
    isWanted: () => boolean
    onResult: (result: VADResult) => void
    onSpeechStart: () => void
    onSpeechEnd: (audio: ArrayBuffer) => void
  }
) => {
  const { MicVAD } = await import('@ricky0123/vad-web')
  const { threshold, isWanted, onResult, onSpeechStart, onSpeechEnd } = handlers

  const originalWarn = console.warn
  console.warn = (...args) => {
    if (args[0]?.includes?.('onnxruntime') ||
        args[0]?.includes?.('Removing initializer')) {
      return // Suppress these warnings
    }
    originalWarn(...args)
  }

  try {
    return await MicVAD.new({
      ...vadAssetPaths(),
      ...streams,
      startOnLoad: false,
      positiveSpeechThreshold: threshold,
      minSpeechMs: 300,
      preSpeechPadMs: 100, // Changed from preSpeechPadFrames to preSpeechPadMs
      model: 'v5',
      // A frame already being judged when the mic was turned off can still raise an event.
      onFrameProcessed: (probs: VADProbs) => {
        if (isWanted() && probs.isSpeech && probs.isSpeech > threshold) {
          onResult({
            isSpeech: true,
            confidence: probs.isSpeech
          })
        }
      },
      onSpeechStart: () => {
        if (!isWanted()) return
        console.log('Speech started')
        onSpeechStart()
      },
      onSpeechEnd: (audio: Float32Array) => {
        if (!isWanted()) return
        //   console.log('Speech ended', audio)

        // Convert Float32Array to ArrayBuffer for compatibility
        const buffer = new ArrayBuffer(audio.length * 4)
        const view = new Float32Array(buffer)
        view.set(audio)

        onResult({
          isSpeech: false,
          confidence: 1.0,
          audio: buffer
        })

        onSpeechEnd(buffer)
      }
    })
  } finally {
    console.warn = originalWarn
  }
}

export const useVADService = ({
  config: configPartial = {},
  onVADResult,
  onSpeechStart,
  onSpeechEnd,
  onUnavailable
}: UseVADServiceProps = {}) => {
  const config = useMemo(() => ({ ...defaultVadConfig, ...configPartial }), [configPartial])

  const [isListening, setIsListening] = useState(false)
  const [isDetecting, setIsDetecting] = useState(false)

  // The caller passes a new config object and new callbacks on every render. They are read through
  // refs, so the actions below keep one identity and a render never starts or loads anything.
  const latestRef = useRef({ config, onVADResult, onSpeechStart, onSpeechEnd, onUnavailable })
  useLayoutEffect(() => {
    latestRef.current = { config, onVADResult, onSpeechStart, onSpeechEnd, onUnavailable }
  })

  useEffect(()=>{console.log("set listening" , isListening)},[isListening])

  const [controller] = useState(() => {
    const handleVADResult = (result: VADResult) => {
      // console.log('VAD Result:', result)
      setIsDetecting(result.isSpeech)

      // Call callback if provided
      latestRef.current.onVADResult?.(result)
    }

    const created = createMicVADController({
      load: (streams) =>
        loadMicVAD(streams, {
          threshold: latestRef.current.config.vadThreshold,
          isWanted: () => created.isWanted(),
          onResult: handleVADResult,
          onSpeechStart: () => {
            setIsDetecting(true)
            latestRef.current.onSpeechStart?.()
          },
          onSpeechEnd: (audio) => {
            setIsDetecting(false)
            latestRef.current.onSpeechEnd?.(audio)
          }
        }),
      onListeningChange: setIsListening,
      onUnavailable: (error) => latestRef.current.onUnavailable?.(error)
    })
    return created
  })

  /** Loads the detector ahead of use. It does not open the microphone. */
  const initializeVAD = useCallback(() => controller.load(), [controller])

  const startListening = useCallback(async () => {
    if (!latestRef.current.config.vadEnabled) return
    await controller.start()
  }, [controller])

  const stopListening = useCallback(async () => {
    setIsDetecting(false)
    await controller.stop()
  }, [controller])

  // Auto-start/stop based on microphone enabled setting
  useEffect(() => {
    if (config.microphoneEnabled && config.vadEnabled) {
      startListening()
    } else {
      stopListening()
    }
  }, [config.microphoneEnabled, config.vadEnabled, startListening, stopListening])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      void controller.release()
    }
  }, [controller])

  const actions = useMemo(
    () => ({
      startListening,
      stopListening,
      initializeVAD
    }),
    [startListening, stopListening, initializeVAD]
  )

  const state = useMemo(() => ({
    isListening,
    isDetecting
  }), [isListening, isDetecting])

  return useMemo(
    () => ({
      state,
      actions
    }),
    [state, actions]
  )
}
