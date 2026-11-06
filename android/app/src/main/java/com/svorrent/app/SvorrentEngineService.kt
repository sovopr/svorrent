package com.svorrent.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
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
    private var lastTitle: String = ""
    private var lastSub: String = ""

    override fun onCreate() {
        super.onCreate()
        isServiceRunning = true
        SvorrentEngine.init(applicationContext)
        createNotificationChannel()
        promoteToForeground("Svorrent · Idle", "Wi-Fi + Mobile Data bonding ready", isOngoing = false)

        serviceScope.launch {
            while (true) {
                try {
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
                        "${active.size} active · Bonded (${net.bondedCount} networks)"
                    } else {
                        "${active.size} active transfer${if (active.size == 1) "" else "s"}"
                    }

                    // Only invoke SystemUI binder IPC when the notification text actually changes
                    if (title != lastTitle || sub != lastSub) {
                        lastTitle = title
                        lastSub = sub
                        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
                        nm.notify(NOTIFICATION_ID, buildNotification(title, sub, isOngoing = active.isNotEmpty()))
                    }

                    delay(if (active.isNotEmpty()) 2000L else 4000L)
                } catch (_: Throwable) {
                    delay(4000L)
                }
            }
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopEngineService()
            return START_NOT_STICKY
        }
        isServiceRunning = true
        createNotificationChannel()
        val list = SvorrentEngine.torrents.value
        val active = list.filter { !it.done && !it.paused }
        promoteToForeground(
            lastTitle.ifEmpty { "Svorrent · Idle" },
            lastSub.ifEmpty { "Wi-Fi + Mobile Data bonding ready" },
            isOngoing = active.isNotEmpty()
        )
        return START_NOT_STICKY
    }

    override fun onTaskRemoved(rootIntent: Intent?) {
        val active = SvorrentEngine.torrents.value.filter { !it.done && !it.paused }
        if (active.isEmpty()) {
            stopEngineService()
        }
        super.onTaskRemoved(rootIntent)
    }

    private fun stopEngineService() {
        isServiceRunning = false
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                stopForeground(STOP_FOREGROUND_REMOVE)
            } else {
                @Suppress("DEPRECATION")
                stopForeground(true)
            }
            val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            nm.cancel(NOTIFICATION_ID)
        } catch (_: Throwable) {
        }
        stopSelf()
    }

    private fun promoteToForeground(title: String, text: String, isOngoing: Boolean) {
        try {
            val notification = buildNotification(title, text, isOngoing)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(
                    NOTIFICATION_ID,
                    notification,
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
                )
            } else {
                startForeground(NOTIFICATION_ID, notification)
            }
        } catch (_: Throwable) {
            // Guard against foreground start restrictions on strict OEM ROMs
        }
    }

    override fun onDestroy() {
        isServiceRunning = false
        try {
            val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            nm.cancel(NOTIFICATION_ID)
        } catch (_: Throwable) {
        }
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
                description = "Active torrent transfers and multi-network bonding telemetry"
                setShowBadge(false)
            }
            val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            nm.createNotificationChannel(channel)
        }
    }

    private fun buildNotification(title: String, text: String, isOngoing: Boolean): Notification {
        val openIntent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        val pi = PendingIntent.getActivity(
            this,
            0,
            openIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val stopIntent = Intent(this, SvorrentEngineService::class.java).apply {
            action = ACTION_STOP
        }
        val stopPi = PendingIntent.getService(
            this,
            1,
            stopIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.stat_sys_download)
            .setContentTitle(title)
            .setContentText(text)
            .setOngoing(isOngoing)
            .setOnlyAlertOnce(true)
            .setContentIntent(pi)
            .addAction(android.R.drawable.ic_menu_close_clear_cancel, "Exit", stopPi)
            .build()
    }

    companion object {
        const val ACTION_STOP = "com.svorrent.app.ACTION_STOP_SERVICE"
        private const val CHANNEL_ID = "svorrent_transfers"
        private const val NOTIFICATION_ID = 3001

        @Volatile
        private var isServiceRunning = false

        fun ensureRunning(context: Context) {
            if (isServiceRunning) return
            val appCtx = context.applicationContext
            val intent = Intent(appCtx, SvorrentEngineService::class.java)
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    appCtx.startForegroundService(intent)
                } else {
                    appCtx.startService(intent)
                }
            } catch (_: Throwable) {
            }
        }
    }
}
