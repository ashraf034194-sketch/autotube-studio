'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Play, Pause, AudioLines } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Slider } from '@/components/ui/slider'

function formatTime(seconds: number): string {
  const secs = Math.max(0, Math.floor(seconds))
  const m = Math.floor(secs / 60)
  const s = secs % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

interface VoiceoverPlayerProps {
  /** Object URL of the generated audio blob */
  url: string
  /** Duration reported by the server (ffprobe), used until metadata loads */
  durationSeconds: number
}

export function VoiceoverPlayer({ url, durationSeconds }: VoiceoverPlayerProps) {
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const [isPlaying, setIsPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(durationSeconds)
  const [seeking, setSeeking] = useState<number | null>(null)

  // NOTE: This component is remounted via `key={url}` from the parent whenever
  // a new voiceover is generated, so state resets naturally between audios.

  // Attach audio element listeners
  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return

    const onTimeUpdate = () => setCurrentTime(audio.currentTime)
    const onLoadedMetadata = () => {
      if (Number.isFinite(audio.duration) && audio.duration > 0) {
        setDuration(audio.duration)
      }
    }
    const onEnded = () => {
      setIsPlaying(false)
      setCurrentTime(0)
    }
    const onPlay = () => setIsPlaying(true)
    const onPause = () => setIsPlaying(false)

    audio.addEventListener('timeupdate', onTimeUpdate)
    audio.addEventListener('loadedmetadata', onLoadedMetadata)
    audio.addEventListener('ended', onEnded)
    audio.addEventListener('play', onPlay)
    audio.addEventListener('pause', onPause)

    return () => {
      audio.removeEventListener('timeupdate', onTimeUpdate)
      audio.removeEventListener('loadedmetadata', onLoadedMetadata)
      audio.removeEventListener('ended', onEnded)
      audio.removeEventListener('play', onPlay)
      audio.removeEventListener('pause', onPause)
    }
  }, [url])

  const togglePlay = useCallback(() => {
    const audio = audioRef.current
    if (!audio) return
    if (audio.paused) {
      audio.play().catch(() => {
        // Autoplay/interruption failures are non-fatal
      })
    } else {
      audio.pause()
    }
  }, [])

  const handleSeek = useCallback((value: number[]) => {
    const audio = audioRef.current
    if (!audio || value.length === 0) return
    const time = value[0]
    setSeeking(time)
    audio.currentTime = time
    setCurrentTime(time)
    // Clear the "seeking" marker shortly after dragging stops
    window.setTimeout(() => setSeeking(null), 150)
  }, [])

  const progress = duration > 0 ? (seeking ?? currentTime) / duration : 0

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-950/70 p-4">
      <audio ref={audioRef} src={url} preload="metadata" className="hidden" />

      <div className="flex items-center gap-4">
        {/* Play / Pause */}
        <Button
          type="button"
          onClick={togglePlay}
          aria-label={isPlaying ? 'Pause voiceover' : 'Play voiceover'}
          className="h-12 w-12 shrink-0 rounded-full bg-red-600 p-0 text-white shadow-lg shadow-red-600/25 hover:bg-red-500"
        >
          {isPlaying ? (
            <Pause className="h-5 w-5" aria-hidden="true" />
          ) : (
            <Play className="ml-0.5 h-5 w-5" aria-hidden="true" />
          )}
        </Button>

        {/* Waveform-ish visual + seek bar */}
        <div className="flex-1 space-y-2">
          <div className="flex items-center justify-between text-xs text-zinc-400">
            <span className="inline-flex items-center gap-1.5 font-medium text-zinc-300">
              <AudioLines className="h-3.5 w-3.5 text-red-400" aria-hidden="true" />
              Voiceover narration
            </span>
            <span className="font-mono tabular-nums">
              {formatTime(seeking ?? currentTime)} / {formatTime(duration)}
            </span>
          </div>
          <Slider
            value={[seeking ?? currentTime]}
            max={Math.max(duration, 0.1)}
            step={0.1}
            onValueChange={handleSeek}
            aria-label="Seek position"
            className="cursor-pointer **:data-[slot=slider-range]:bg-red-600 **:data-[slot=slider-thumb]:border-red-500 **:data-[slot=slider-thumb]:bg-red-600"
          />
          {/* Progress ticks for visual interest */}
          <div className="flex h-1.5 items-center gap-[3px] overflow-hidden" aria-hidden="true">
            {Array.from({ length: 48 }).map((_, i) => {
              const active = i / 48 <= progress
              const base = active ? 'bg-red-500' : 'bg-zinc-800'
              const heights = ['h-1.5', 'h-3', 'h-1.5', 'h-2.5', 'h-1', 'h-3.5', 'h-2']
              return (
                <div
                  key={i}
                  className={`w-full rounded-full transition-colors ${base} ${heights[i % heights.length]}`}
                />
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}
