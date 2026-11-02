package com.pchat.app

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.app.RemoteInput
import kotlinx.coroutines.launch

/** Buttons on a message notification: «پاسخ» (typed right in the notification) and «خوانده شد». */
object NotifActions {
    const val REPLY = "com.pchat.app.action.REPLY"
    const val READ = "com.pchat.app.action.READ"
    const val KEY_TEXT = "text"

    fun pending(ctx: Context, action: String, convo: String): PendingIntent {
        val i = Intent(ctx, NotifActionReceiver::class.java).setAction(action).putExtra("convo", convo)
        // the system writes the typed reply into the intent, so the reply intent must be mutable
        val mut = if (action == REPLY) PendingIntent.FLAG_MUTABLE else PendingIntent.FLAG_IMMUTABLE
        return PendingIntent.getBroadcast(ctx, (action + convo).hashCode(), i, PendingIntent.FLAG_UPDATE_CURRENT or mut)
    }
}

class NotifActionReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val convo = intent.getStringExtra("convo") ?: return
        Engine.init(context)
        if (Api.token == null) return
        val pending = goAsync()
        Engine.scope.launch {
            try {
                when (intent.action) {
                    NotifActions.REPLY -> {
                        val text = RemoteInput.getResultsFromIntent(intent)?.getCharSequence(NotifActions.KEY_TEXT)?.toString()?.trim()
                        if (!text.isNullOrEmpty()) Engine.replyFromNotification(convo, text.take(4000))
                    }
                    NotifActions.READ -> Engine.readFromNotification(convo)
                }
            } catch (e: Exception) {
            } finally {
                pending.finish()
            }
        }
    }
}
