package com.pchat.app

import android.content.Context
import android.media.AudioAttributes
import android.media.MediaPlayer
import android.media.MediaRecorder
import android.os.Build
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import java.io.File

/**
 * Records a voice message: AAC in MPEG-4 (.m4a, plays on iPhone and in every browser), mono, 32 kbit/s.
 * The loudness is sampled every 100 ms for the waveform (50 bars of 0..31, same as the web app).
 */
class VoiceRecorder(ctx: Context, val file: File) {
    private val rec: MediaRecorder = if (Build.VERSION.SDK_INT >= 31) MediaRecorder(ctx) else @Suppress("DEPRECATION") MediaRecorder()
    private val levels = ArrayList<Int>()
    private var sampler: Job? = null
    private var started = 0L
    /** latest loudness 0..1, for the recording indicator */
    val level = MutableStateFlow(0f)

    fun start() {
        rec.setAudioSource(MediaRecorder.AudioSource.MIC)
        rec.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
        rec.setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
        rec.setAudioChannels(1)
        rec.setAudioSamplingRate(44100)
        rec.setAudioEncodingBitRate(32000)
        rec.setOutputFile(file.absolutePath)
        rec.prepare()
        rec.start()
        started = System.currentTimeMillis()
        sampler = Engine.scope.launch {
            while (isActive) {
                delay(100)
                val a = try { rec.maxAmplitude } catch (e: Exception) { 0 }
                synchronized(levels) { levels.add(a) }
                level.value = (a / 32767f).coerceIn(0f, 1f)
            }
        }
    }

    fun elapsed(): Long = if (started == 0L) 0 else System.currentTimeMillis() - started

    /** Stops; returns (length in ms, waveform), or null if nothing usable was recorded. */
    fun stop(): Pair<Long, List<Int>>? {
        val dur = elapsed()
        sampler?.cancel()
        val ok = try { rec.stop(); true } catch (e: Exception) { false }
        rec.release()
        if (!ok || !file.exists() || file.length() == 0L) { file.delete(); return null }
        return dur to waveform(synchronized(levels) { levels.toList() })
    }

    fun cancel() {
        sampler?.cancel()
        try { rec.stop() } catch (e: Exception) { }
        rec.release()
        file.delete()
    }

    companion object {
        /** Squeezes the 100 ms samples into [bars] values 0..31 (relative to the loudest one). */
        fun waveform(levels: List<Int>, bars: Int = 50): List<Int> {
            if (levels.isEmpty()) return List(bars) { 0 }
            val max = maxOf(levels.max(), 600).toFloat()
            return (0 until bars).map { i ->
                val a = i * levels.size / bars
                val b = maxOf(a + 1, (i + 1) * levels.size / bars)
                var m = 0
                for (j in a until minOf(b, levels.size)) m = maxOf(m, levels[j])
                Math.round(minOf(1f, m / max) * 31)
            }
        }
    }
}

/** One shared player for voice messages; the bubble that plays shows progress from [state]. */
object VoicePlayer {
    data class State(val id: Long = 0, val playing: Boolean = false, val pos: Long = 0, val dur: Long = 0)

    val state = MutableStateFlow(State())
    private var player: MediaPlayer? = null
    private var ticker: Job? = null

    /** Playback speed of voice messages (1.7): 1x, 1.5x, 2x, remembered; the pitch stays the same. */
    private val RATES = floatArrayOf(1f, 1.5f, 2f)
    val rate = MutableStateFlow(Engine.prefs.getFloat("voice_rate", 1f).takeIf { r -> RATES.any { it == r } } ?: 1f)

    /** Next speed (1 -> 1.5 -> 2 -> 1); the message that is playing changes at once. */
    fun cycleRate() {
        val i = RATES.indexOfFirst { it == rate.value }
        rate.value = RATES[(i + 1) % RATES.size]
        Engine.prefs.edit().putFloat("voice_rate", rate.value).apply()
        player?.let { applyRate(it) }
    }

    private fun applyRate(mp: MediaPlayer) {
        try {
            val wasPlaying = mp.isPlaying
            mp.playbackParams = mp.playbackParams.setSpeed(rate.value).setPitch(1f)
            // setting the speed starts a paused player on some phones: keep it paused
            if (!wasPlaying && mp.isPlaying) mp.pause()
        } catch (e: Exception) { }
    }

    /** Plays / pauses voice message [id] from the decrypted file at [path]. */
    fun toggle(id: Long, path: String) {
        val p = player
        if (p != null && state.value.id == id) {
            if (p.isPlaying) { p.pause(); state.value = state.value.copy(playing = false) }
            else { p.start(); applyRate(p); state.value = state.value.copy(playing = true); tick() }
            return
        }
        stop()
        try {
            val mp = MediaPlayer()
            mp.setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
            mp.setDataSource(path)
            mp.setOnCompletionListener { stop() }
            mp.prepare()
            mp.start()
            applyRate(mp)
            player = mp
            state.value = State(id, true, 0, mp.duration.toLong().coerceAtLeast(0))
            tick()
        } catch (e: Exception) {
            stop()
        }
    }

    /** Jumps to a fraction 0..1 of the message that is playing. */
    fun seek(id: Long, frac: Float) {
        val p = player ?: return
        if (state.value.id != id) return
        val to = (frac.coerceIn(0f, 1f) * p.duration).toInt()
        p.seekTo(to)
        state.value = state.value.copy(pos = to.toLong())
    }

    fun stop() {
        ticker?.cancel()
        player?.let { try { it.stop() } catch (e: Exception) { }; it.release() }
        player = null
        state.value = State()
    }

    private fun tick() {
        ticker?.cancel()
        ticker = Engine.scope.launch {
            while (isActive) {
                val p = player ?: break
                val pos = try { p.currentPosition.toLong() } catch (e: Exception) { break }
                state.value = state.value.copy(pos = pos)
                if (!state.value.playing) break
                delay(100)
            }
        }
    }
}
