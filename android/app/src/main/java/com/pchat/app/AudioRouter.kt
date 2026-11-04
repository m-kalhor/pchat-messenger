package com.pchat.app

import android.content.Context
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
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
 */
object AudioRouter {
    private val main = Handler(Looper.getMainLooper())
    private var am: AudioManager? = null
    private var active = false
    private var wantSpeaker = false
    private var picked: AudioRoute? = null
    private var current = AudioRoute.EARPIECE
    private var onChange: ((AudioRoute, Boolean) -> Unit)? = null

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
        main.post {
            val m = ctx.applicationContext.getSystemService(AudioManager::class.java)
            am = m
            onChange = listener
            wantSpeaker = speaker
            picked = null
            try { m.mode = AudioManager.MODE_IN_COMMUNICATION } catch (e: Exception) { }
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
        if (dev == null || !m.setCommunicationDevice(dev)) throw IllegalStateException("route")
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
