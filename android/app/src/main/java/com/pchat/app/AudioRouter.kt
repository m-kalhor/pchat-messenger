package com.pchat.app

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.os.Build
import android.os.Handler
import android.os.Looper

/** Where the call audio goes. */
enum class AudioRoute { EARPIECE, SPEAKER, BLUETOOTH }

/**
 * 1.9: call audio routing with Bluetooth headsets. A connected headset takes the call automatically;
 * the call screen's audio button cycles earpiece → speaker → Bluetooth. When a headset connects or
 * disconnects during the call the audio follows it. Android 12+ uses setCommunicationDevice, older
 * versions Bluetooth SCO.
 *
 * 1.10.1 (Samsung: calls only worked on the speaker): the phone is put in call mode and the app takes the
 * call audio focus at once, before WebRTC opens its audio, not a moment later on the main thread; call
 * mode is set again if something resets it; when Android refuses the earpiece through
 * setCommunicationDevice, the older speakerphone switch is used instead. [debug] shows the real route
 * in the call diagnostics.
 */
object AudioRouter {
    private val main = Handler(Looper.getMainLooper())
    private var am: AudioManager? = null
    private var active = false
    private var wantSpeaker = false
    private var picked: AudioRoute? = null
    private var current = AudioRoute.EARPIECE
    private var onChange: ((AudioRoute, Boolean) -> Unit)? = null
    private var focus: AudioFocusRequest? = null

    /** What Android really does with the call audio right now (for the call diagnostics). */
    fun debug(): String {
        val m = am ?: return "audio: –"
        return try {
            val mode = when (m.mode) { AudioManager.MODE_IN_COMMUNICATION -> "call"; AudioManager.MODE_NORMAL -> "normal"; AudioManager.MODE_IN_CALL -> "in-call"; else -> m.mode.toString() }
            val dev = if (Build.VERSION.SDK_INT >= 31) m.communicationDevice?.let { devName(it.type) } ?: "none"
            else { @Suppress("DEPRECATION") if (m.isBluetoothScoOn) "bluetooth" else if (m.isSpeakerphoneOn) "speaker" else "earpiece" }
            "audio: $mode · $dev · picked ${current.name.lowercase()} (${Build.MANUFACTURER} ${Build.MODEL}, Android ${Build.VERSION.RELEASE})"
        } catch (e: Exception) { "audio: ?" }
    }

    private fun devName(t: Int) = when (t) {
        AudioDeviceInfo.TYPE_BUILTIN_EARPIECE -> "earpiece"
        AudioDeviceInfo.TYPE_BUILTIN_SPEAKER -> "speaker"
        AudioDeviceInfo.TYPE_WIRED_HEADSET, AudioDeviceInfo.TYPE_WIRED_HEADPHONES -> "wired"
        AudioDeviceInfo.TYPE_USB_HEADSET -> "usb"
        AudioDeviceInfo.TYPE_BLUETOOTH_SCO -> "bluetooth"
        else -> "type $t"
    }

    private fun callMode(m: AudioManager) {
        try { if (m.mode != AudioManager.MODE_IN_COMMUNICATION) m.mode = AudioManager.MODE_IN_COMMUNICATION } catch (e: Exception) { }
    }

    private val callback = object : AudioDeviceCallback() {
        override fun onAudioDevicesAdded(added: Array<out AudioDeviceInfo>) {
            if (added.any { isBt(it) }) picked = null // a headset just connected: it takes the call
            main.postDelayed({ apply() }, 300)
        }
        override fun onAudioDevicesRemoved(removed: Array<out AudioDeviceInfo>) {
            if (removed.any { isBt(it) } && picked == AudioRoute.BLUETOOTH) picked = null
            main.postDelayed({ apply() }, 300)
        }
    }

    private fun isBt(d: AudioDeviceInfo): Boolean =
        d.type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO ||
            (Build.VERSION.SDK_INT >= 31 && (d.type == AudioDeviceInfo.TYPE_BLE_HEADSET))

    /** Starts routing for a call; [speaker] is the default without a headset (video calls use the speaker). */
    fun start(ctx: Context, speaker: Boolean, listener: (AudioRoute, Boolean) -> Unit) {
        // 1.10.1: call mode and audio focus right now, on the calling thread (AudioManager allows it), so they
        // are in place before WebRTC creates its audio track
        val m0 = ctx.applicationContext.getSystemService(AudioManager::class.java)
        am = m0
        callMode(m0)
        if (focus == null) {
            try {
                val f = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
                    .setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
                    .setOnAudioFocusChangeListener({ }, main)
                    .build()
                m0.requestAudioFocus(f)
                focus = f
            } catch (e: Exception) { }
        }
        main.post {
            val m = m0
            onChange = listener
            wantSpeaker = speaker
            picked = null
            callMode(m)
            if (!active) { try { m.registerAudioDeviceCallback(callback, main) } catch (e: Exception) { } }
            active = true
            apply()
        }
    }

    fun stop() {
        main.post {
            val m = am ?: return@post
            if (active) { try { m.unregisterAudioDeviceCallback(callback) } catch (e: Exception) { } }
            active = false
            onChange = null
            focus?.let { try { m.abandonAudioFocusRequest(it) } catch (e: Exception) { } }
            focus = null
            try {
                if (Build.VERSION.SDK_INT >= 31) m.clearCommunicationDevice()
                else {
                    @Suppress("DEPRECATION") if (m.isBluetoothScoOn) { m.stopBluetoothSco(); m.isBluetoothScoOn = false }
                }
            } catch (e: Exception) { }
            try {
                @Suppress("DEPRECATION") m.isSpeakerphoneOn = false
                m.mode = AudioManager.MODE_NORMAL
            } catch (e: Exception) { }
        }
    }

    /** The next route: earpiece → speaker → Bluetooth (when a headset is connected) → earpiece. */
    fun cycle() {
        main.post {
            if (!active) return@post
            val bt = btAvailable()
            val next = when (current) {
                AudioRoute.EARPIECE -> AudioRoute.SPEAKER
                AudioRoute.SPEAKER -> if (bt) AudioRoute.BLUETOOTH else AudioRoute.EARPIECE
                AudioRoute.BLUETOOTH -> AudioRoute.EARPIECE
            }
            picked = next
            if (next != AudioRoute.BLUETOOTH) wantSpeaker = next == AudioRoute.SPEAKER
            apply()
        }
    }

    private fun btAvailable(): Boolean {
        val m = am ?: return false
        return try {
            if (Build.VERSION.SDK_INT >= 31) m.availableCommunicationDevices.any { isBt(it) }
            else m.getDevices(AudioManager.GET_DEVICES_OUTPUTS).any { isBt(it) }
        } catch (e: Exception) { false }
    }

    private fun apply() {
        val m = am ?: return
        if (!active) return
        callMode(m)
        val bt = btAvailable()
        val route = when {
            picked == AudioRoute.BLUETOOTH && bt -> AudioRoute.BLUETOOTH
            picked != null && picked != AudioRoute.BLUETOOTH -> picked!!
            bt -> AudioRoute.BLUETOOTH
            wantSpeaker -> AudioRoute.SPEAKER
            else -> AudioRoute.EARPIECE
        }
        val ok = try { if (Build.VERSION.SDK_INT >= 31) set31(m, route) else setOld(m, route); true } catch (e: Exception) { false }
        current = if (ok) route else (if (wantSpeaker) AudioRoute.SPEAKER else AudioRoute.EARPIECE)
        onChange?.invoke(current, bt)
    }

    private fun set31(m: AudioManager, route: AudioRoute) {
        val devs = m.availableCommunicationDevices
        val dev = when (route) {
            AudioRoute.BLUETOOTH -> devs.firstOrNull { isBt(it) }
            AudioRoute.SPEAKER -> devs.firstOrNull { it.type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER }
            // a wired / USB headset counts as "the phone" like the earpiece
            AudioRoute.EARPIECE -> devs.firstOrNull { it.type == AudioDeviceInfo.TYPE_WIRED_HEADSET || it.type == AudioDeviceInfo.TYPE_USB_HEADSET }
                ?: devs.firstOrNull { it.type == AudioDeviceInfo.TYPE_BUILTIN_EARPIECE }
        }
        val ok = dev != null && try { m.setCommunicationDevice(dev) } catch (e: Exception) { false }
        if (ok) return
        // 1.10.1: some Samsung phones refuse (or have no "earpiece" device in the list); fall back to the
        // older switch, which they honour
        if (route == AudioRoute.BLUETOOTH) throw IllegalStateException("route")
        try { m.clearCommunicationDevice() } catch (e: Exception) { }
        @Suppress("DEPRECATION")
        m.isSpeakerphoneOn = route == AudioRoute.SPEAKER
    }

    @Suppress("DEPRECATION")
    private fun setOld(m: AudioManager, route: AudioRoute) {
        if (route == AudioRoute.BLUETOOTH) {
            m.isSpeakerphoneOn = false
            m.startBluetoothSco()
            m.isBluetoothScoOn = true
        } else {
            if (m.isBluetoothScoOn) { m.stopBluetoothSco(); m.isBluetoothScoOn = false }
            m.isSpeakerphoneOn = route == AudioRoute.SPEAKER
        }
    }
}
