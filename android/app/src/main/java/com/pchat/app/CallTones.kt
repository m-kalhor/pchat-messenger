package com.pchat.app

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import kotlin.math.PI
import kotlin.math.min
import kotlin.math.sin

/**
 * 1.13: call progress tones, generated in code (no sound files, nothing to license).
 * Same style as Iran's phone network: 425 Hz, ringback 1 s on / 4 s off, busy 0.5 s on / 0.5 s off,
 * and the three rising "special information" notes for a user who can't be reached.
 *
 * Tones play with USAGE_VOICE_COMMUNICATION, so they come out of the same place as the call itself
 * (earpiece, speaker or Bluetooth headset, see AudioRouter). Only one tone plays at a time.
 */
object CallTones {
    enum class Tone { RINGBACK, BUSY, UNREACHABLE, END, RING }

    private const val SR = 16000
    private class Seg(val ms: Int, vararg val hz: Double)

    @Volatile private var gen = 0

    private fun pattern(t: Tone): List<Seg> = when (t) {
        Tone.RINGBACK -> listOf(Seg(1000, 425.0), Seg(4000))
        Tone.BUSY -> List(4) { listOf(Seg(500, 425.0), Seg(500)) }.flatten()
        Tone.UNREACHABLE -> List(2) { listOf(Seg(330, 950.0), Seg(330, 1400.0), Seg(330, 1800.0), Seg(900)) }.flatten()
        Tone.END -> listOf(Seg(180, 425.0), Seg(120), Seg(180, 425.0), Seg(120), Seg(180, 425.0))
        // fallback ringtone for a phone without one: two soft notes, twice, then a pause
        Tone.RING -> listOf(Seg(400, 784.0, 1568.0), Seg(400, 659.0, 1318.0), Seg(400, 784.0, 1568.0), Seg(400, 659.0, 1318.0), Seg(2000))
    }

    private fun loops(t: Tone) = t == Tone.RINGBACK || t == Tone.RING

    /** How long a one-shot tone lasts (0 for the looping ones). */
    fun durationMs(t: Tone): Long = if (loops(t)) 0L else pattern(t).sumOf { it.ms }.toLong()

    private fun render(segs: List<Seg>): ShortArray {
        val total = segs.sumOf { it.ms * SR / 1000 }
        val out = ShortArray(total)
        var pos = 0
        val fade = SR * 8 / 1000 // 8 ms fade in/out, no clicks
        for (s in segs) {
            val n = s.ms * SR / 1000
            if (s.hz.isNotEmpty()) {
                val amp = 0.32 * Short.MAX_VALUE / s.hz.size
                for (i in 0 until n) {
                    val env = min(1.0, min(i, n - 1 - i).toDouble() / fade)
                    var v = 0.0
                    for (f in s.hz) v += sin(2 * PI * f * i / SR)
                    out[pos + i] = (v * amp * env).toInt().toShort()
                }
            }
            pos += n
        }
        return out
    }

    fun play(t: Tone, usage: Int = AudioAttributes.USAGE_VOICE_COMMUNICATION) {
        val my = synchronized(this) { ++gen }
        val loop = loops(t)
        Thread({
            var track: AudioTrack? = null
            var natural = false
            try {
                val pcm = render(pattern(t))
                val minBuf = AudioTrack.getMinBufferSize(SR, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT)
                track = AudioTrack.Builder()
                    .setAudioAttributes(
                        AudioAttributes.Builder().setUsage(usage)
                            .setContentType(if (usage == AudioAttributes.USAGE_VOICE_COMMUNICATION) AudioAttributes.CONTENT_TYPE_SPEECH else AudioAttributes.CONTENT_TYPE_SONIFICATION)
                            .build()
                    )
                    .setAudioFormat(AudioFormat.Builder().setSampleRate(SR).setEncoding(AudioFormat.ENCODING_PCM_16BIT).setChannelMask(AudioFormat.CHANNEL_OUT_MONO).build())
                    .setBufferSizeInBytes(maxOf(minBuf, 4096))
                    .setTransferMode(AudioTrack.MODE_STREAM)
                    .build()
                track.play()
                do {
                    var off = 0
                    while (off < pcm.size && gen == my) {
                        val n = track.write(pcm, off, min(1600, pcm.size - off)) // 100 ms per write: stops quickly
                        if (n <= 0) break
                        off += n
                    }
                } while (loop && gen == my)
                natural = gen == my
            } catch (e: Exception) {
            } finally {
                try {
                    if (natural) track?.stop() // plays what is left in the buffer
                    else { track?.pause(); track?.flush() }
                } catch (e: Exception) { }
                if (natural) try { Thread.sleep(250) } catch (e: Exception) { }
                try { track?.release() } catch (e: Exception) { }
            }
        }, "call-tone").start()
    }

    fun stop() { synchronized(this) { gen++ } }
}
