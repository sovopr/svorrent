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

        val initialActive = SvorrentEngine.torrents.value.filter { !it.done && !it.paused }
        if (initialActive.isEmpty()) {
            promoteToForeground("Svorrent", "Idle", isOngoing = false)
            stopEngineService()
            return
        }

        promoteToForeground("Svorrent · Starting…", "Connecting to peers…", isOngoing = true)

        serviceScope.launch {
            while (true) {
                try {
                    val list = SvorrentEngine.torrents.value
                    val active = list.filter { !it.done && !it.paused }

                    if (active.isEmpty()) {
                        stopEngineService()
                        break
                    }

                    val down = active.sumOf { it.downloadSpeed }
                    val up = list.filter { !it.paused }.sumOf { it.uploadSpeed }
                    val net = SvorrentEngine.networkSnapshot.value

                    val title = "↓ ${Formatters.formatSpeed(down)}  ·  ↑ ${Formatters.formatSpeed(up)}"
                    val sub = if (net.bondedCount > 1) {
                        "${active.size} active · Bonded (${net.bondedCount} networks)"
                    } else {
                        "${active.size} active transfer${if (active.size == 1) "" else "s"}"
                    }

                    if (title != lastTitle || sub != lastSub) {
                        lastTitle = title
                        lastSub = sub
                        promoteToForeground(title, sub, isOngoing = true)
                    }

                    delay(2000L)
                } catch (_: Throwable) {
                    delay(3000L)
                }
            }
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            val active = SvorrentEngine.torrents.value.filter { !it.done && !it.paused }
            for (t in active) {
                SvorrentEngine.togglePause(t.infoHash)
            }
            stopEngineService()
            return START_NOT_STICKY
        }

        isServiceRunning = true
        createNotificationChannel()
        val list = SvorrentEngine.torrents.value
        val active = list.filter { !it.done && !it.paused }
        if (active.isEmpty()) {
            promoteToForeground("Svorrent", "Idle", isOngoing = false)
            stopEngineService()
            return START_NOT_STICKY
        }

        promoteToForeground(
            lastTitle.ifEmpty { "Svorrent · Starting…" },
            lastSub.ifEmpty { "Connecting to peers…" },
            isOngoing = true
        )
        return START_NOT_STICKY
    }

    override fun onTaskRemoved(rootIntent: Intent?) {
        isAppInForeground = false
        val active = SvorrentEngine.torrents.value.filter { !it.done && !it.paused }
        if (active.isEmpty()) {
            stopEngineService()
        }
        super.onTaskRemoved(rootIntent)
    }

    private fun dismissNotificationAndDemote() {
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
    }

    private fun stopEngineService() {
        isServiceRunning = false
        dismissNotificationAndDemote()
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
        }
    }

    override fun onDestroy() {
        isServiceRunning = false
        dismissNotificationAndDemote()
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
        var isAppInForeground: Boolean = false

        @Volatile
        private var isServiceRunning = false

        fun ensureRunning(context: Context) {
            val active = SvorrentEngine.torrents.value.filter { !it.done && !it.paused }
            // Only spawn foreground service if there are active transfers running
            if (active.isEmpty()) return
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

        fun stopIfIdle(context: Context) {
            val active = SvorrentEngine.torrents.value.filter { !it.done && !it.paused }
            if (active.isEmpty() && isServiceRunning) {
                val appCtx = context.applicationContext
                val stopIntent = Intent(appCtx, SvorrentEngineService::class.java).apply {
                    action = ACTION_STOP
                }
                try {
                    appCtx.startService(stopIntent)
                } catch (_: Throwable) {
                }
            }
        }
    }
}
