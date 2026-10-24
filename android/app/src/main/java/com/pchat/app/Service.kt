package com.pchat.app

import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.net.wifi.WifiManager
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch

/** Keeps the live connection to the server alive so messages arrive without Google push services. */
class MessengerService : Service() {
    private var job: Job? = null
    private var wakeLock: PowerManager.WakeLock? = null
    private var wifiLock: WifiManager.WifiLock? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        Engine.init(this)
        // Messages/calls matter more than battery: keep CPU and Wi-Fi awake so the connection never sleeps.
        try {
            wakeLock = getSystemService(PowerManager::class.java)
                .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "pchat:connection").apply { setReferenceCounted(false); acquire() }
        } catch (e: Exception) { }
        try {
            val mode = if (Build.VERSION.SDK_INT >= 29) WifiManager.WIFI_MODE_FULL_LOW_LATENCY else @Suppress("DEPRECATION") WifiManager.WIFI_MODE_FULL_HIGH_PERF
            wifiLock = applicationContext.getSystemService(WifiManager::class.java)
                .createWifiLock(mode, "pchat:wifi").apply { setReferenceCounted(false); acquire() }
        } catch (e: Exception) { }
        Engine.watchNetwork()
        Engine.startOutboxTicker()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val n = NotificationCompat.Builder(this, Engine.CH_SVC)
            .setSmallIcon(android.R.drawable.stat_notify_chat)
            .setContentTitle("سپن فعال است")
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .build()
        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(1, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING)
        } else {
            startForeground(1, n)
        }
        if (job?.isActive != true) {
            job = Engine.scope.launch {
                Engine.streamLoop()
                stopSelf()
            }
        }
        return START_STICKY
    }

    override fun onDestroy() {
        job?.cancel()
        Api.cancelStream()
        try { wakeLock?.release() } catch (e: Exception) { }
        try { wifiLock?.release() } catch (e: Exception) { }
        super.onDestroy()
    }
}

class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == Intent.ACTION_BOOT_COMPLETED) {
            Engine.init(context)
            if (Engine.loggedIn.value) {
                ContextCompat.startForegroundService(context, Intent(context, MessengerService::class.java))
            }
        }
    }
}

/** Foreground service that keeps microphone/camera alive while a call is running. */
class CallService : Service() {
    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val video = intent?.getBooleanExtra("video", false) ?: false
        val n = NotificationCompat.Builder(this, Engine.CH_SVC)
            .setSmallIcon(android.R.drawable.sym_action_call)
            .setContentTitle("تماس در جریان است")
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()
        if (Build.VERSION.SDK_INT >= 30) {
            var t = ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
            if (video) t = t or ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA
            startForeground(2, n, t)
        } else {
            startForeground(2, n)
        }
        return START_NOT_STICKY
    }
}
