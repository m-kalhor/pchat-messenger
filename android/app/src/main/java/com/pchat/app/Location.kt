package com.pchat.app

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.CancellationSignal
import android.os.Looper
import android.widget.Toast
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import java.util.Locale
import kotlin.coroutines.resume

/**
 * The phone's own position from GPS / the network provider (LocationManager), without Google Play
 * services. The caller must already hold ACCESS_FINE_LOCATION or ACCESS_COARSE_LOCATION.
 */
object GeoLocation {
    @SuppressLint("MissingPermission")
    suspend fun current(ctx: Context): Loc? = withContext(Dispatchers.Main) {
        val lm = ctx.getSystemService(LocationManager::class.java) ?: return@withContext null
        val providers = listOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER).filter {
            try { lm.isProviderEnabled(it) } catch (e: Exception) { false }
        }
        if (providers.isEmpty()) return@withContext null
        // a fix from the last two minutes is good enough
        val recent = providers.mapNotNull { try { lm.getLastKnownLocation(it) } catch (e: Exception) { null } }
            .filter { System.currentTimeMillis() - it.time < 120_000 }
            .minByOrNull { it.accuracy }
        if (recent != null && recent.accuracy <= 50f) return@withContext recent.toLoc()
        val fresh = withTimeoutOrNull(20_000) { firstFix(lm, providers) }
        (fresh ?: recent)?.toLoc()
    }

    private fun Location.toLoc() = Loc(latitude, longitude, if (hasAccuracy()) accuracy.toInt() else 0)

    /** The first new position from any of [providers] (GPS usually wins outdoors, the network indoors). */
    @SuppressLint("MissingPermission")
    private suspend fun firstFix(lm: LocationManager, providers: List<String>): Location? = suspendCancellableCoroutine { cont ->
        val listeners = ArrayList<LocationListener>()
        val signals = ArrayList<CancellationSignal>()
        fun done(l: Location?) {
            if (!cont.isActive) return
            listeners.forEach { try { lm.removeUpdates(it) } catch (e: Exception) { } }
            signals.forEach { it.cancel() }
            cont.resume(l)
        }
        for (p in providers) {
            try {
                if (Build.VERSION.SDK_INT >= 30) {
                    val sig = CancellationSignal()
                    signals.add(sig)
                    lm.getCurrentLocation(p, sig, ctxExecutor()) { l -> if (l != null) done(l) }
                } else {
                    val l = object : LocationListener {
                        override fun onLocationChanged(location: Location) = done(location)
                        @Deprecated("Deprecated in Java")
                        override fun onStatusChanged(provider: String?, status: Int, extras: Bundle?) {}
                        override fun onProviderEnabled(provider: String) {}
                        override fun onProviderDisabled(provider: String) {}
                    }
                    listeners.add(l)
                    lm.requestLocationUpdates(p, 0L, 0f, l, Looper.getMainLooper())
                }
            } catch (e: Exception) { }
        }
        cont.invokeOnCancellation {
            listeners.forEach { try { lm.removeUpdates(it) } catch (e: Exception) { } }
            signals.forEach { it.cancel() }
        }
    }

    private fun ctxExecutor() = java.util.concurrent.Executor { r -> android.os.Handler(Looper.getMainLooper()).post(r) }

    fun coords(l: Loc) = "%.5f, %.5f".format(Locale.US, l.lat, l.lon)

    /** Opens the point in whatever map app the phone has (geo: link), else in the browser (OpenStreetMap). */
    fun openMap(ctx: Context, l: Loc) {
        val lat = "%.6f".format(Locale.US, l.lat)
        val lon = "%.6f".format(Locale.US, l.lon)
        try {
            ctx.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("geo:$lat,$lon?q=$lat,$lon")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        } catch (e: Exception) {
            try {
                ctx.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("https://www.openstreetmap.org/?mlat=$lat&mlon=$lon#map=17/$lat/$lon")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            } catch (x: Exception) {
                Toast.makeText(ctx, "برنامه‌ای برای نمایش نقشه پیدا نشد", Toast.LENGTH_SHORT).show()
            }
        }
    }
}
