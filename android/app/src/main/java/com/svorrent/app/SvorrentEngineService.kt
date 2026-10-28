package com.svorrent.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

class SvorrentEngineService : Service() {
    private val serviceScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    override fun onCreate() {
        super.onCreate()
        SvorrentEngine.init(applicationContext)
        createNotificationChannel()
        startForeground(NOTIFICATION_ID, buildNotification("Svorrent engine ready", "Wi-Fi + Mobile Data bonding active"))

        serviceScope.launch {
            while (true) {
                val list = SvorrentEngine.torrents.value
                val active = list.filter { !it.done && !it.paused }
                val down = active.sumOf { it.downloadSpeed }
                val up = list.filter { !it.paused }.sumOf { it.uploadSpeed }
                val net = SvorrentEngine.networkSnapshot.value

                val title = if (active.isNotEmpty()) {
                    "↓ ${Formatters.formatSpeed(down)}  ·  ↑ ${Formatters.formatSpeed(up)}"
                } else {
                    "Svorrent · Idle"
                }

                val sub = if (net.bondedCount > 1) {
                    "${active.size} active · Multi-interface bonding (${net.bondedCount} networks)"
                } else {
                    "${active.size} active transfer${if (active.size == 1) "" else "s"}"
                }

                val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
                nm.notify(NOTIFICATION_ID, buildNotification(title, sub))
                delay(2000L)
            }
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        return START_STICKY
    }

    override fun onDestroy() {
        serviceScope.cancel()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "Svorrent Transfers",
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = "Active BitTorrent transfers and multi-network bonding telemetry"
                setShowBadge(false)
            }
            val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            nm.createNotificationChannel(channel)
        }
    }

    private fun buildNotification(title: String, text: String): Notification {
        val openIntent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        val pi = PendingIntent.getActivity(
            this,
            0,
            openIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.stat_sys_download)
            .setContentTitle(title)
            .setContentText(text)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setContentIntent(pi)
            .build()
    }

    companion object {
        private const val CHANNEL_ID = "svorrent_transfers"
        private const val NOTIFICATION_ID = 3001

        fun ensureRunning(context: Context) {
            val appCtx = context.applicationContext
            val intent = Intent(appCtx, SvorrentEngineService::class.java)
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    appCtx.startForegroundService(intent)
                } else {
                    appCtx.startService(intent)
                }
            } catch (_: Exception) {
            }
        }
    }
}
