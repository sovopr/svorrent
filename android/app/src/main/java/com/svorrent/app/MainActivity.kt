package com.svorrent.app

import android.Manifest
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.core.content.FileProvider
import androidx.core.view.WindowCompat
import kotlinx.coroutines.launch
import java.io.File
import kotlin.math.max

// Svorrent Exact Palette
private val BgDark = Color(0xFF121314)
private val SurfaceDark = Color(0xFF17181A)
private val Surface2Dark = Color(0xFF1E2023)
private val BorderDark = Color(0xFF26282C)
private val BorderStrong = Color(0xFF34373D)
private val TextPrimary = Color(0xFFEDEDEB)
private val TextSecondary = Color(0xFFA3A4A8)
private val TextMuted = Color(0xFF6E7076)
private val AccentBlue = Color(0xFF5B8DEE)
private val OkGreen = Color(0xFF57AB72)
private val WarnAmber = Color(0xFFC9A24A)
private val DangerRed = Color(0xFFD9625A)

class MainActivity : ComponentActivity() {
    private val permissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        runCatching {
            window.statusBarColor = android.graphics.Color.parseColor("#121314")
            window.navigationBarColor = android.graphics.Color.parseColor("#121314")
            val controller = WindowCompat.getInsetsController(window, window.decorView)
            controller.isAppearanceLightStatusBars = false
            controller.isAppearanceLightNavigationBars = false
        }

        SvorrentEngine.init(applicationContext)
        SvorrentEngineService.ensureRunning(applicationContext)
        requestNecessaryPermissions()
        handleIncomingMagnetIntent(intent)

        setContent {
            MaterialTheme(
                colorScheme = darkColorScheme(
                    background = BgDark,
                    surface = SurfaceDark,
                    primary = AccentBlue,
                    onBackground = TextPrimary,
                    onSurface = TextPrimary
                )
            ) {
                SvorrentApp()
            }
        }
    }

    override fun onStart() {
        super.onStart()
        SvorrentEngineService.isAppInForeground = true
    }

    override fun onStop() {
        SvorrentEngineService.isAppInForeground = false
        SvorrentEngineService.stopIfIdle(applicationContext)
        super.onStop()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleIncomingMagnetIntent(intent)
    }

    private fun handleIncomingMagnetIntent(intent: Intent?) {
        val data = intent?.dataString ?: return
        if (data.startsWith("magnet:?", ignoreCase = true)) {
            SvorrentEngine.addMagnet(data).onSuccess {
                Toast.makeText(this, "Added magnet to Downloads", Toast.LENGTH_SHORT).show()
            }
        }
    }

    private fun requestNecessaryPermissions() {
        val perms = mutableListOf<String>()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            perms.add(Manifest.permission.POST_NOTIFICATIONS)
        }
        if (Build.VERSION.SDK_INT <= Build.VERSION_CODES.Q) {
            perms.add(Manifest.permission.WRITE_EXTERNAL_STORAGE)
            perms.add(Manifest.permission.READ_EXTERNAL_STORAGE)
        }
        if (perms.isNotEmpty()) {
            runCatching { permissionLauncher.launch(perms.toTypedArray()) }
        }
    }
}

@Composable
fun SigmaBrandLogo(size: Dp = 20.dp) {
    Canvas(
        modifier = Modifier
            .size(size)
            .clip(RoundedCornerShape(4.5.dp))
    ) {
        drawRect(
            brush = Brush.linearGradient(
                colors = listOf(Color(0xFF38BDF8), Color(0xFF0284C7)),
                start = Offset.Zero,
                end = Offset(this.size.width, this.size.height)
            )
        )
        val w = this.size.width
        val h = this.size.height
        val path = Path().apply {
            moveTo(w * 0.734f, h * 0.265f)
            lineTo(w * 0.297f, h * 0.265f)
            lineTo(w * 0.562f, h * 0.500f)
            lineTo(w * 0.297f, h * 0.734f)
            lineTo(w * 0.734f, h * 0.734f)
        }
        drawPath(
            path = path,
            color = Color(0xFF0B1220),
            style = Stroke(
                width = w * 0.105f,
                cap = StrokeCap.Round,
                join = StrokeJoin.Round
            )
        )
    }
}

/**
 * Compact 28dp × 16dp visual toggle switch with sliding circular thumb.
 * Gives unmistakable interactive toggle affordance without overflowing mobile rows.
 */
@Composable
fun MiniToggleSwitch(
    checked: Boolean,
    activeColor: Color = OkGreen,
    enabled: Boolean = true
) {
    val trackColor = when {
        !enabled -> Surface2Dark
        checked -> activeColor
        else -> BorderStrong
    }
    val thumbColor = when {
        !enabled -> TextMuted
        checked -> BgDark
        else -> TextSecondary
    }

    Box(
        modifier = Modifier
            .width(28.dp)
            .height(16.dp)
            .clip(RoundedCornerShape(8.dp))
            .background(trackColor)
            .padding(2.dp),
        contentAlignment = if (checked) Alignment.CenterEnd else Alignment.CenterStart
    ) {
        Box(
            modifier = Modifier
                .size(12.dp)
                .clip(CircleShape)
                .background(thumbColor)
        )
    }
}

@Composable
fun MiniSparkline(
    data: List<Long>,
    color: Color,
    width: Dp = 64.dp,
    height: Dp = 18.dp
) {
    Canvas(modifier = Modifier.size(width, height)) {
        if (data.size < 2 || size.width <= 0f || size.height <= 0f) return@Canvas
        val maxVal = (data.maxOrNull() ?: 1024L).coerceAtLeast(1024L).toFloat()
        val hasSignal = data.any { it > 0L }
        val path = Path()
        val w = size.width
        val h = size.height
        data.forEachIndexed { idx, value ->
            val x = (idx.toFloat() / (data.size - 1).toFloat()) * w
            val y = h - (value.coerceAtMost(maxVal.toLong()).toFloat() / maxVal) * (h - 6f) - 3f
            if (idx == 0) path.moveTo(x, y) else path.lineTo(x, y)
        }
        drawPath(
            path = path,
            color = color.copy(alpha = if (hasSignal) 1f else 0.45f),
            style = Stroke(width = 3.2f, cap = StrokeCap.Round, join = StrokeJoin.Round)
        )
    }
}

@Composable
fun SvorrentApp() {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val torrents by SvorrentEngine.torrents.collectAsState()
    val netSnapshot by SvorrentEngine.networkSnapshot.collectAsState()
    val autoStopSeeding by SvorrentEngine.autoStopSeeding.collectAsState()
    val updateState by AutoUpdater.state.collectAsState()

    var currentTab by remember { mutableStateOf("search") }
    var swarmTarget by remember { mutableStateOf<TorrentItem?>(null) }
    var detailsTarget by remember { mutableStateOf<TorrentItem?>(null) }
    var showUpdateModal by remember { mutableStateOf(false) }

    LaunchedEffect(Unit) {
        AutoUpdater.checkForUpdates()
    }

    // Harmonize top-bar speeds with network snapshot so upload & download always match Networks tab
    val torrentDownSum = torrents.filter { !it.done && !it.paused }.sumOf { it.downloadSpeed }
    val torrentUpSum = torrents.filter { !it.paused }.sumOf { it.uploadSpeed }
    val totalDown = max(netSnapshot.totalDownSpeed, torrentDownSum)
    val totalUp = max(netSnapshot.totalUpSpeed, torrentUpSum)

    Scaffold(
        modifier = Modifier
            .fillMaxSize()
            .background(BgDark)
            .navigationBarsPadding(),
        containerColor = BgDark,
        topBar = {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(BgDark)
                    .statusBarsPadding()
            ) {
                // Row 1: Brand + Live Speeds + Update Pill
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(46.dp)
                        .padding(horizontal = 14.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.SpaceBetween
                ) {
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                        modifier = Modifier.clickable { currentTab = "search" }
                    ) {
                        SigmaBrandLogo(size = 20.dp)
                        Text(
                            text = "svorrent",
                            color = TextPrimary,
                            fontSize = 15.sp,
                            fontWeight = FontWeight.SemiBold,
                            letterSpacing = (-0.2).sp
                        )
                    }

                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(8.dp)
                    ) {
                        Text(
                            text = "↓ ${Formatters.formatSpeed(totalDown)}",
                            color = if (totalDown > 0) OkGreen else TextSecondary,
                            fontSize = 11.sp,
                            fontFamily = FontFamily.Monospace,
                            maxLines = 1,
                            softWrap = false
                        )
                        Text(
                            text = "↑ ${Formatters.formatSpeed(totalUp)}",
                            color = if (totalUp > 0) AccentBlue else TextSecondary,
                            fontSize = 11.sp,
                            fontFamily = FontFamily.Monospace,
                            maxLines = 1,
                            softWrap = false
                        )

                        val isUpdateAvailable = updateState.status in listOf("available", "downloading", "ready")
                        if (isUpdateAvailable) {
                            Box(
                                modifier = Modifier
                                    .clip(RoundedCornerShape(4.dp))
                                    .border(1.dp, AccentBlue, RoundedCornerShape(4.dp))
                                    .background(AccentBlue.copy(alpha = 0.15f))
                                    .clickable { showUpdateModal = true }
                                    .padding(horizontal = 7.dp, vertical = 3.dp)
                            ) {
                                Text(
                                    text = when (updateState.status) {
                                        "downloading" -> "Downloading… ${updateState.downloadProgress}%"
                                        "ready" -> "Ready to Install"
                                        else -> "↑ Update"
                                    },
                                    color = AccentBlue,
                                    fontSize = 10.5.sp,
                                    fontFamily = FontFamily.Monospace,
                                    maxLines = 1,
                                    softWrap = false
                                )
                            }
                        }
                    }
                }

                // Row 2: Navigation Tabs Row
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(38.dp)
                        .padding(horizontal = 10.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(6.dp)
                ) {
                    TopNavTab(
                        label = "Search",
                        badgeCount = null,
                        selected = currentTab == "search",
                        onClick = { currentTab = "search" }
                    )
                    TopNavTab(
                        label = "Downloads",
                        badgeCount = torrents.size.takeIf { it > 0 },
                        selected = currentTab == "downloads",
                        onClick = { currentTab = "downloads" }
                    )
                    TopNavTab(
                        label = "Networks",
                        badgeCount = netSnapshot.bondedCount.takeIf { it > 1 },
                        selected = currentTab == "networks",
                        onClick = { currentTab = "networks" }
                    )
                }

                HorizontalDivider(color = BorderDark, thickness = 1.dp)
            }
        }
    ) { innerPadding ->
        Box(
            modifier = Modifier
                .fillMaxSize()
                .padding(innerPadding)
                .background(BgDark)
        ) {
            when (currentTab) {
                "search" -> SearchScreen(
                    onMagnetAdded = {
                        currentTab = "downloads"
                    }
                )
                "downloads" -> DownloadsScreen(
                    torrents = torrents,
                    autoStopSeeding = autoStopSeeding,
                    onToggleAutoStop = { SvorrentEngine.setAutoStopSeeding(it) },
                    onOpenSwarm = { swarmTarget = it },
                    onOpenDetails = { detailsTarget = it },
                    onPlayVideo = { torrent ->
                        val path = torrent.primaryVideoFile
                        if (path != null) {
                            launchVideoPlayer(context, File(path))
                        } else {
                            Toast.makeText(context, torrent.playReason, Toast.LENGTH_SHORT).show()
                        }
                    }
                )
                "networks" -> NetworksScreen(
                    snapshot = netSnapshot,
                    updateState = updateState,
                    onOpenUpdateModal = { showUpdateModal = true }
                )
            }
        }
    }

    swarmTarget?.let { target ->
        val liveTorrent = torrents.find { it.infoHash == target.infoHash } ?: target
        SwarmInspectorDialog(
            torrent = liveTorrent,
            onDismiss = { swarmTarget = null }
        )
    }

    detailsTarget?.let { target ->
        val liveTorrent = torrents.find { it.infoHash == target.infoHash } ?: target
        TorrentDetailsDialog(
            torrent = liveTorrent,
            onDismiss = { detailsTarget = null }
        )
    }

    if (showUpdateModal) {
        UpdateDialog(
            updateState = updateState,
            onCheckNow = { scope.launch { AutoUpdater.checkForUpdates() } },
            onDownloadAndInstall = { url -> scope.launch { AutoUpdater.downloadAndInstallApk(context, url) } },
            onInstallDownloaded = { AutoUpdater.installDownloadedApk(context) },
            onOpenBrowserDownload = { AutoUpdater.openPrivateReleaseApkDownload(context) },
            onDownloadLatestApk = {
                scope.launch {
                    AutoUpdater.downloadAndInstallApk(
                        context,
                        updateState.apkDownloadUrl ?: AutoUpdater.PUBLIC_LATEST_APK_URL
                    )
                }
            },
            onDismiss = { showUpdateModal = false }
        )
    }
}

@Composable
private fun TopNavTab(
    label: String,
    badgeCount: Int?,
    selected: Boolean,
    onClick: () -> Unit
) {
    Column(
        modifier = Modifier
            .fillMaxHeight()
            .clickable(onClick = onClick)
            .padding(horizontal = 10.dp),
        verticalArrangement = Arrangement.SpaceBetween,
        horizontalAlignment = Alignment.CenterHorizontally
    ) {
        Spacer(modifier = Modifier.height(2.dp))
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(5.dp)
        ) {
            Text(
                text = label,
                color = if (selected) TextPrimary else TextSecondary,
                fontSize = 13.sp,
                fontWeight = if (selected) FontWeight.Medium else FontWeight.Normal,
                maxLines = 1,
                softWrap = false
            )
            if (badgeCount != null) {
                Box(
                    modifier = Modifier
                        .clip(RoundedCornerShape(4.dp))
                        .background(if (selected) AccentBlue.copy(alpha = 0.2f) else Surface2Dark)
                        .padding(horizontal = 5.dp, vertical = 1.dp)
                ) {
                    Text(
                        text = badgeCount.toString(),
                        color = if (selected) AccentBlue else TextSecondary,
                        fontSize = 10.5.sp,
                        fontFamily = FontFamily.Monospace
                    )
                }
            }
        }
        Box(
            modifier = Modifier
                .height(2.dp)
                .width(52.dp)
                .background(if (selected) TextPrimary else Color.Transparent)
        )
    }
}

@Composable
fun SearchScreen(onMagnetAdded: () -> Unit) {
    val context = LocalContext.current
    val focusManager = LocalFocusManager.current
    val scope = rememberCoroutineScope()

    var query by remember { mutableStateOf("") }
    var searchedQuery by remember { mutableStateOf("") }
    var selectedCategory by remember { mutableStateOf("All") }
    var sortBy by remember { mutableStateOf("seeds") }
    var loading by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var results by remember { mutableStateOf<List<SearchResultItem>>(emptyList()) }

    fun triggerSearch() {
        val term = query.trim()
        if (term.isEmpty()) return
        if (term.startsWith("magnet:?", ignoreCase = true) || term.matches(Regex("^[0-9a-fA-F]{40}$"))) {
            SvorrentEngine.addMagnet(term).onSuccess {
                Toast.makeText(context, "Added to Downloads", Toast.LENGTH_SHORT).show()
                query = ""
                onMagnetAdded()
            }.onFailure { err ->
                Toast.makeText(context, err.message ?: "Invalid magnet", Toast.LENGTH_SHORT).show()
            }
            return
        }

        focusManager.clearFocus()
        loading = true
        error = null
        scope.launch {
            try {
                val res = SearchRepository.search(term)
                results = res
                searchedQuery = term
            } catch (e: Exception) {
                error = e.message ?: "Search failed"
            } finally {
                loading = false
            }
        }
    }

    val filteredResults = remember(results, selectedCategory, sortBy) {
        val byCat = if (selectedCategory == "All") {
            results
        } else {
            results.filter { it.category.equals(selectedCategory, ignoreCase = true) }
        }
        when (sortBy) {
            "size" -> byCat.sortedByDescending { it.sizeBytes }
            else -> byCat.sortedByDescending { it.seeds }
        }
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(horizontal = 14.dp, vertical = 12.dp)
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            Row(
                modifier = Modifier
                    .weight(1f)
                    .height(42.dp)
                    .border(1.dp, BorderStrong, RoundedCornerShape(6.dp))
                    .background(SurfaceDark, RoundedCornerShape(6.dp))
                    .padding(horizontal = 11.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                Icon(
                    imageVector = Icons.Outlined.Search,
                    contentDescription = null,
                    tint = TextMuted,
                    modifier = Modifier.size(17.dp)
                )
                Spacer(modifier = Modifier.width(8.dp))
                Box(
                    modifier = Modifier.weight(1f),
                    contentAlignment = Alignment.CenterStart
                ) {
                    if (query.isEmpty()) {
                        Text(
                            text = "Search torrents or paste magnet…",
                            color = TextMuted,
                            fontSize = 13.sp,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis
                        )
                    }
                    BasicTextField(
                        value = query,
                        onValueChange = { query = it },
                        singleLine = true,
                        textStyle = TextStyle(
                            color = TextPrimary,
                            fontSize = 13.5.sp
                        ),
                        cursorBrush = SolidColor(AccentBlue),
                        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
                        keyboardActions = KeyboardActions(onSearch = { triggerSearch() }),
                        modifier = Modifier.fillMaxWidth()
                    )
                }
                if (query.isNotEmpty()) {
                    Icon(
                        imageVector = Icons.Default.Close,
                        contentDescription = "Clear",
                        tint = TextMuted,
                        modifier = Modifier
                            .size(18.dp)
                            .clickable { query = "" }
                    )
                }
            }

            Button(
                onClick = { triggerSearch() },
                enabled = !loading && query.isNotBlank(),
                shape = RoundedCornerShape(6.dp),
                colors = ButtonDefaults.buttonColors(
                    containerColor = TextPrimary,
                    contentColor = BgDark,
                    disabledContainerColor = Surface2Dark,
                    disabledContentColor = TextMuted
                ),
                contentPadding = PaddingValues(horizontal = 16.dp, vertical = 0.dp),
                modifier = Modifier.height(42.dp)
            ) {
                Text(
                    text = if (loading) "…" else "Search",
                    fontSize = 13.sp,
                    fontWeight = FontWeight.SemiBold,
                    maxLines = 1,
                    softWrap = false
                )
            }
        }

        if (searchedQuery.isNotEmpty() || results.isNotEmpty()) {
            Spacer(modifier = Modifier.height(10.dp))
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .horizontalScroll(rememberScrollState()),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(6.dp)
            ) {
                listOf("All", "Video", "Audio", "Apps", "Games").forEach { cat ->
                    val active = selectedCategory == cat
                    Box(
                        modifier = Modifier
                            .clip(RoundedCornerShape(5.dp))
                            .border(1.dp, if (active) BorderStrong else BorderDark, RoundedCornerShape(5.dp))
                            .background(if (active) Surface2Dark else SurfaceDark)
                            .clickable { selectedCategory = cat }
                            .padding(horizontal = 10.dp, vertical = 5.dp)
                    ) {
                        Text(
                            text = cat,
                            color = if (active) TextPrimary else TextSecondary,
                            fontSize = 11.5.sp,
                            fontWeight = if (active) FontWeight.Medium else FontWeight.Normal,
                            maxLines = 1,
                            softWrap = false
                        )
                    }
                }

                Spacer(modifier = Modifier.width(4.dp))

                Box(
                    modifier = Modifier
                        .clip(RoundedCornerShape(5.dp))
                        .border(1.dp, BorderDark, RoundedCornerShape(5.dp))
                        .background(SurfaceDark)
                        .clickable { sortBy = if (sortBy == "seeds") "size" else "seeds" }
                        .padding(horizontal = 10.dp, vertical = 5.dp)
                ) {
                    Text(
                        text = if (sortBy == "seeds") "Sort: Seeds ▼" else "Sort: Size ▼",
                        color = TextSecondary,
                        fontSize = 11.5.sp,
                        fontFamily = FontFamily.Monospace,
                        maxLines = 1,
                        softWrap = false
                    )
                }
            }
        }

        Spacer(modifier = Modifier.height(10.dp))

        if (error != null) {
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .border(1.dp, DangerRed.copy(alpha = 0.4f), RoundedCornerShape(6.dp))
                    .background(SurfaceDark, RoundedCornerShape(6.dp))
                    .padding(12.dp)
            ) {
                Text(text = error!!, color = DangerRed, fontSize = 12.5.sp)
            }
            Spacer(modifier = Modifier.height(10.dp))
        }

        if (loading) {
            Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                CircularProgressIndicator(color = AccentBlue, strokeWidth = 2.dp, modifier = Modifier.size(28.dp))
            }
        } else if (searchedQuery.isNotEmpty()) {
            Text(
                text = "${filteredResults.size} results for “$searchedQuery”",
                color = TextSecondary,
                fontSize = 12.sp,
                modifier = Modifier.padding(bottom = 8.dp)
            )

            LazyColumn(
                modifier = Modifier
                    .fillMaxSize()
                    .border(1.dp, BorderDark, RoundedCornerShape(6.dp))
                    .background(SurfaceDark, RoundedCornerShape(6.dp))
            ) {
                items(filteredResults, key = { it.id }) { item ->
                    Column(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(horizontal = 12.dp, vertical = 10.dp)
                    ) {
                        Text(
                            text = item.title,
                            color = TextPrimary,
                            fontSize = 13.5.sp,
                            fontWeight = FontWeight.Medium,
                            maxLines = 2,
                            overflow = TextOverflow.Ellipsis
                        )
                        Spacer(modifier = Modifier.height(8.dp))

                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.SpaceBetween
                        ) {
                            Row(
                                modifier = Modifier
                                    .weight(1f)
                                    .padding(end = 8.dp),
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.spacedBy(8.dp)
                            ) {
                                Text(
                                    text = item.sizeFormatted,
                                    color = TextSecondary,
                                    fontSize = 11.5.sp,
                                    fontFamily = FontFamily.Monospace,
                                    maxLines = 1,
                                    softWrap = false
                                )
                                Text(
                                    text = "▲ ${item.seeds}",
                                    color = when {
                                        item.seeds >= 50 -> OkGreen
                                        item.seeds >= 5 -> TextPrimary
                                        else -> TextMuted
                                    },
                                    fontSize = 11.5.sp,
                                    fontFamily = FontFamily.Monospace,
                                    maxLines = 1,
                                    softWrap = false
                                )
                                Text(
                                    text = "▼ ${item.leechers}",
                                    color = TextMuted,
                                    fontSize = 11.5.sp,
                                    fontFamily = FontFamily.Monospace,
                                    maxLines = 1,
                                    softWrap = false
                                )
                                Text(
                                    text = item.category,
                                    color = TextMuted,
                                    fontSize = 11.sp,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis
                                )
                            }

                            Row(
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.spacedBy(6.dp)
                            ) {
                                Box(
                                    modifier = Modifier
                                        .size(28.dp)
                                        .clip(RoundedCornerShape(5.dp))
                                        .border(1.dp, BorderDark, RoundedCornerShape(5.dp))
                                        .background(Surface2Dark)
                                        .clickable {
                                            val cm = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                                            cm.setPrimaryClip(ClipData.newPlainText("magnet", item.magnet))
                                            Toast.makeText(context, "Copied magnet link", Toast.LENGTH_SHORT).show()
                                        },
                                    contentAlignment = Alignment.Center
                                ) {
                                    Icon(
                                        imageVector = Icons.Outlined.ContentCopy,
                                        contentDescription = "Copy Magnet",
                                        tint = TextSecondary,
                                        modifier = Modifier.size(14.dp)
                                    )
                                }

                                Box(
                                    modifier = Modifier
                                        .height(28.dp)
                                        .clip(RoundedCornerShape(5.dp))
                                        .border(1.dp, BorderStrong, RoundedCornerShape(5.dp))
                                        .background(Surface2Dark)
                                        .clickable {
                                            // Pass exact item.title so Downloads tab never shows Magnet-<hex>
                                            SvorrentEngine.addMagnet(item.magnet, preferredTitle = item.title).onSuccess {
                                                Toast.makeText(context, "Added to Downloads", Toast.LENGTH_SHORT).show()
                                                onMagnetAdded()
                                            }.onFailure { err ->
                                                Toast.makeText(context, err.message ?: "Failed to add magnet", Toast.LENGTH_SHORT).show()
                                            }
                                        }
                                        .padding(horizontal = 10.dp),
                                    contentAlignment = Alignment.Center
                                ) {
                                    Text(
                                        text = "↓ Download",
                                        color = TextPrimary,
                                        fontSize = 11.5.sp,
                                        fontWeight = FontWeight.Medium,
                                        maxLines = 1,
                                        softWrap = false
                                    )
                                }
                            }
                        }
                    }
                    HorizontalDivider(color = BorderDark, thickness = 1.dp)
                }
            }
        } else {
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(top = 56.dp, start = 16.dp, end = 16.dp),
                contentAlignment = Alignment.Center
            ) {
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    Text(
                        text = "Search public torrents",
                        color = TextSecondary,
                        fontSize = 14.sp,
                        fontWeight = FontWeight.Medium
                    )
                    Spacer(modifier = Modifier.height(6.dp))
                    Text(
                        text = "Enter a query above or paste a magnet link to start downloading over Wi-Fi + Mobile Data.",
                        color = TextMuted,
                        fontSize = 12.sp,
                        textAlign = TextAlign.Center
                    )
                }
            }
        }
    }
}

@Composable
fun DownloadsScreen(
    torrents: List<TorrentItem>,
    autoStopSeeding: Boolean,
    onToggleAutoStop: (Boolean) -> Unit,
    onOpenSwarm: (TorrentItem) -> Unit,
    onOpenDetails: (TorrentItem) -> Unit,
    onPlayVideo: (TorrentItem) -> Unit
) {
    val context = LocalContext.current
    var filter by remember { mutableStateOf("active") }
    var showMagnetDialog by remember { mutableStateOf(false) }
    var magnetInput by remember { mutableStateOf("") }
    var deleteTarget by remember { mutableStateOf<TorrentItem?>(null) }
    var deleteFilesFromDisk by remember { mutableStateOf(false) }

    val activeList = torrents.filter { !it.done }
    val completedList = torrents.filter { it.done }
    val visible = if (filter == "completed") completedList else activeList

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(horizontal = 14.dp, vertical = 12.dp)
    ) {
        // Header Row
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween
        ) {
            Column(
                modifier = Modifier
                    .weight(1f)
                    .padding(end = 8.dp)
            ) {
                Text(
                    text = "Downloads",
                    color = TextPrimary,
                    fontSize = 17.sp,
                    fontWeight = FontWeight.SemiBold
                )
                Text(
                    text = "Saved to ${SvorrentEngine.displayDownloadPath}",
                    color = TextMuted,
                    fontSize = 11.sp,
                    fontFamily = FontFamily.Monospace,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis
                )
            }

            Box(
                modifier = Modifier
                    .height(32.dp)
                    .clip(RoundedCornerShape(6.dp))
                    .border(1.dp, BorderStrong, RoundedCornerShape(6.dp))
                    .background(SurfaceDark)
                    .clickable { showMagnetDialog = true }
                    .padding(horizontal = 12.dp),
                contentAlignment = Alignment.Center
            ) {
                Text(
                    text = "+ Magnet / Hash",
                    color = TextPrimary,
                    fontSize = 12.sp,
                    fontWeight = FontWeight.Medium,
                    maxLines = 1,
                    softWrap = false
                )
            }
        }

        Spacer(modifier = Modifier.height(10.dp))

        // Filter & Visual Mini-Toggle Switch for "Stop seeding when done"
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween
        ) {
            Row(
                modifier = Modifier
                    .border(1.dp, BorderDark, RoundedCornerShape(6.dp))
                    .background(SurfaceDark, RoundedCornerShape(6.dp))
                    .padding(2.dp),
                horizontalArrangement = Arrangement.spacedBy(2.dp)
            ) {
                FilterSegment(
                    label = "Active ${activeList.size}",
                    selected = filter == "active",
                    onClick = { filter = "active" }
                )
                FilterSegment(
                    label = "Completed ${completedList.size}",
                    selected = filter == "completed",
                    onClick = { filter = "completed" }
                )
            }

            // Interactive Toggle Switch Pill for "Stop seeding when done"
            Row(
                modifier = Modifier
                    .clip(RoundedCornerShape(6.dp))
                    .border(
                        1.dp,
                        if (autoStopSeeding) OkGreen.copy(alpha = 0.6f) else BorderDark,
                        RoundedCornerShape(6.dp)
                    )
                    .background(SurfaceDark)
                    .clickable { onToggleAutoStop(!autoStopSeeding) }
                    .padding(horizontal = 8.dp, vertical = 5.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(7.dp)
            ) {
                Text(
                    text = "Stop seeding",
                    color = if (autoStopSeeding) TextPrimary else TextSecondary,
                    fontSize = 11.sp,
                    maxLines = 1,
                    softWrap = false
                )
                MiniToggleSwitch(
                    checked = autoStopSeeding,
                    activeColor = OkGreen
                )
            }
        }

        Spacer(modifier = Modifier.height(12.dp))

        if (visible.isEmpty()) {
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .border(1.dp, BorderDark, RoundedCornerShape(6.dp))
                    .background(SurfaceDark, RoundedCornerShape(6.dp))
                    .padding(32.dp),
                contentAlignment = Alignment.Center
            ) {
                Text(
                    text = if (filter == "completed") "No completed downloads yet." else "No active downloads.",
                    color = TextMuted,
                    fontSize = 13.sp
                )
            }
        } else {
            LazyColumn(
                modifier = Modifier
                    .fillMaxSize()
                    .border(1.dp, BorderDark, RoundedCornerShape(6.dp))
                    .background(SurfaceDark, RoundedCornerShape(6.dp))
            ) {
                items(visible, key = { it.infoHash }) { t ->
                    val pct = (t.progress * 100f).coerceIn(0f, 100f)
                    val statusLabel = when {
                        t.done && t.paused -> "Completed · Stopped"
                        t.done -> "Completed · Seeding"
                        t.paused -> "Paused"
                        !t.ready -> "Fetching metadata…"
                        t.numPeers == 0 -> "Connecting to peers…"
                        else -> "Downloading"
                    }

                    Column(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(12.dp)
                    ) {
                        Text(
                            text = t.name,
                            color = TextPrimary,
                            fontSize = 13.5.sp,
                            fontWeight = FontWeight.Medium,
                            maxLines = 2,
                            overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.clickable { onOpenDetails(t) }
                        )

                        Spacer(modifier = Modifier.height(6.dp))

                        Box(
                            modifier = Modifier
                                .fillMaxWidth()
                                .height(4.dp)
                                .clip(RoundedCornerShape(2.dp))
                                .background(Surface2Dark)
                        ) {
                            Box(
                                modifier = Modifier
                                    .fillMaxHeight()
                                    .fillMaxWidth(t.progress.coerceIn(0f, 1f))
                                    .background(if (t.done) OkGreen else AccentBlue)
                            )
                        }

                        Spacer(modifier = Modifier.height(6.dp))

                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.SpaceBetween,
                            verticalAlignment = Alignment.CenterVertically
                        ) {
                            Text(
                                text = "${String.format("%.1f", pct)}% · $statusLabel · ${Formatters.formatBytes(t.downloaded)} / ${Formatters.formatBytes(t.length)}",
                                color = TextSecondary,
                                fontSize = 11.sp,
                                fontFamily = FontFamily.Monospace,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                                modifier = Modifier
                                    .weight(1f)
                                    .padding(end = 6.dp)
                            )

                            if (!t.done && !t.paused) {
                                Text(
                                    text = "↓ ${Formatters.formatSpeed(t.downloadSpeed)} · ${t.numPeers}p · ${Formatters.formatEta(t.timeRemainingSec)}",
                                    color = TextPrimary,
                                    fontSize = 11.sp,
                                    fontFamily = FontFamily.Monospace,
                                    maxLines = 1,
                                    softWrap = false
                                )
                            }
                        }

                        Spacer(modifier = Modifier.height(8.dp))

                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.spacedBy(6.dp),
                            verticalAlignment = Alignment.CenterVertically
                        ) {
                            CompactActionBtn(
                                label = if (t.paused) "▶ Resume" else "❚❚ Pause",
                                onClick = { SvorrentEngine.togglePause(t.infoHash) }
                            )

                            if (t.primaryVideoFile != null) {
                                CompactActionBtn(
                                    label = "▶ Play",
                                    enabled = t.canPlay,
                                    onClick = { onPlayVideo(t) }
                                )
                            }

                            CompactActionBtn(
                                label = "Swarm (${t.numPeers})",
                                onClick = { onOpenSwarm(t) }
                            )

                            CompactActionBtn(
                                label = "Details",
                                textColor = TextSecondary,
                                onClick = { onOpenDetails(t) }
                            )

                            Spacer(modifier = Modifier.weight(1f))

                            IconButton(
                                onClick = {
                                    deleteTarget = t
                                    deleteFilesFromDisk = false
                                },
                                modifier = Modifier.size(28.dp)
                            ) {
                                Icon(
                                    imageVector = Icons.Outlined.Delete,
                                    contentDescription = "Remove",
                                    tint = DangerRed,
                                    modifier = Modifier.size(16.dp)
                                )
                            }
                        }
                    }
                    HorizontalDivider(color = BorderDark, thickness = 1.dp)
                }
            }
        }
    }

    if (showMagnetDialog) {
        AlertDialog(
            onDismissRequest = { showMagnetDialog = false },
            containerColor = SurfaceDark,
            title = { Text("Add Magnet or InfoHash", color = TextPrimary, fontSize = 15.sp, fontWeight = FontWeight.SemiBold) },
            text = {
                Column {
                    OutlinedTextField(
                        value = magnetInput,
                        onValueChange = { magnetInput = it },
                        placeholder = { Text("magnet:?xt=urn:btih:…", color = TextMuted, fontSize = 12.sp) },
                        modifier = Modifier.fillMaxWidth(),
                        singleLine = true,
                        colors = OutlinedTextFieldDefaults.colors(
                            focusedBorderColor = BorderStrong,
                            unfocusedBorderColor = BorderDark,
                            focusedTextColor = TextPrimary,
                            unfocusedTextColor = TextPrimary
                        )
                    )
                    Spacer(modifier = Modifier.height(8.dp))
                    CompactActionBtn(
                        label = "Paste from clipboard",
                        onClick = {
                            val cm = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                            val text = cm.primaryClip?.getItemAt(0)?.coerceToText(context)?.toString() ?: ""
                            if (text.isNotBlank()) magnetInput = text.trim()
                        }
                    )
                }
            },
            confirmButton = {
                Button(
                    onClick = {
                        SvorrentEngine.addMagnet(magnetInput).onSuccess {
                            magnetInput = ""
                            showMagnetDialog = false
                            Toast.makeText(context, "Added download", Toast.LENGTH_SHORT).show()
                        }.onFailure { err ->
                            Toast.makeText(context, err.message ?: "Invalid magnet", Toast.LENGTH_SHORT).show()
                        }
                    },
                    colors = ButtonDefaults.buttonColors(containerColor = TextPrimary, contentColor = BgDark)
                ) {
                    Text("Start Download", fontSize = 12.5.sp)
                }
            },
            dismissButton = {
                TextButton(onClick = { showMagnetDialog = false }) {
                    Text("Cancel", color = TextSecondary)
                }
            }
        )
    }

    deleteTarget?.let { target ->
        AlertDialog(
            onDismissRequest = { deleteTarget = null },
            containerColor = SurfaceDark,
            title = { Text("Remove download?", color = TextPrimary, fontSize = 15.sp, fontWeight = FontWeight.SemiBold) },
            text = {
                Column {
                    Text(target.name, color = TextSecondary, fontSize = 12.5.sp)
                    Spacer(modifier = Modifier.height(10.dp))
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        modifier = Modifier.clickable { deleteFilesFromDisk = !deleteFilesFromDisk }
                    ) {
                        Checkbox(
                            checked = deleteFilesFromDisk,
                            onCheckedChange = { deleteFilesFromDisk = it }
                        )
                        Text("Also delete downloaded files from phone storage", color = TextPrimary, fontSize = 12.5.sp)
                    }
                }
            },
            confirmButton = {
                Button(
                    onClick = {
                        SvorrentEngine.removeTorrent(target.infoHash, deleteFilesFromDisk)
                        deleteTarget = null
                    },
                    colors = ButtonDefaults.buttonColors(containerColor = DangerRed, contentColor = TextPrimary)
                ) {
                    Text("Remove", fontSize = 12.5.sp)
                }
            },
            dismissButton = {
                TextButton(onClick = { deleteTarget = null }) {
                    Text("Cancel", color = TextSecondary)
                }
            }
        )
    }
}

@Composable
private fun CompactActionBtn(
    label: String,
    enabled: Boolean = true,
    textColor: Color = TextPrimary,
    onClick: () -> Unit
) {
    Box(
        modifier = Modifier
            .height(28.dp)
            .clip(RoundedCornerShape(5.dp))
            .border(1.dp, if (enabled) BorderStrong else BorderDark, RoundedCornerShape(5.dp))
            .background(Surface2Dark)
            .clickable(enabled = enabled, onClick = onClick)
            .padding(horizontal = 9.dp),
        contentAlignment = Alignment.Center
    ) {
        Text(
            text = label,
            color = if (enabled) textColor else TextMuted,
            fontSize = 11.sp,
            fontWeight = FontWeight.Medium,
            maxLines = 1,
            softWrap = false
        )
    }
}

@Composable
private fun FilterSegment(
    label: String,
    selected: Boolean,
    onClick: () -> Unit
) {
    Box(
        modifier = Modifier
            .clip(RoundedCornerShape(4.dp))
            .background(if (selected) Surface2Dark else Color.Transparent)
            .clickable(onClick = onClick)
            .padding(horizontal = 9.dp, vertical = 5.dp)
    ) {
        Text(
            text = label,
            color = if (selected) TextPrimary else TextSecondary,
            fontSize = 11.5.sp,
            fontWeight = if (selected) FontWeight.Medium else FontWeight.Normal,
            maxLines = 1,
            softWrap = false
        )
    }
}

@Composable
fun NetworksScreen(
    snapshot: NetworkSnapshot,
    updateState: UpdateState,
    onOpenUpdateModal: () -> Unit
) {
    val context = LocalContext.current
    val totalPeers = snapshot.interfaces.sumOf { it.peers }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 14.dp, vertical = 12.dp)
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Column(
                modifier = Modifier
                    .weight(1f)
                    .padding(end = 8.dp)
            ) {
                Text(
                    text = "Networks",
                    color = TextPrimary,
                    fontSize = 17.sp,
                    fontWeight = FontWeight.SemiBold
                )
                Text(
                    text = "Route peer connections across Wi-Fi and Mobile Data simultaneously.",
                    color = TextSecondary,
                    fontSize = 11.5.sp
                )
            }

            CompactActionBtn(
                label = "↻ Refresh",
                onClick = {
                    SvorrentEngine.refreshAdapters()
                    Toast.makeText(context, "Refreshed network interfaces", Toast.LENGTH_SHORT).show()
                }
            )
        }

        Spacer(modifier = Modifier.height(12.dp))

        // 4-Stat KPI Strip (2x2 grid on mobile screen)
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .border(1.dp, BorderDark, RoundedCornerShape(6.dp))
                .background(SurfaceDark, RoundedCornerShape(6.dp))
        ) {
            Row(modifier = Modifier.fillMaxWidth()) {
                Column(
                    modifier = Modifier
                        .weight(1f)
                        .padding(12.dp)
                ) {
                    Text("Download", color = TextMuted, fontSize = 11.5.sp)
                    Spacer(modifier = Modifier.height(4.dp))
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.SpaceBetween,
                        modifier = Modifier.fillMaxWidth()
                    ) {
                        Text(
                            text = if (snapshot.totalDownSpeed > 0) Formatters.formatSpeed(snapshot.totalDownSpeed) else "—",
                            color = TextPrimary,
                            fontSize = 15.sp,
                            fontWeight = FontWeight.SemiBold,
                            fontFamily = FontFamily.Monospace,
                            maxLines = 1
                        )
                        MiniSparkline(data = snapshot.aggregateHistory, color = AccentBlue, width = 50.dp, height = 16.dp)
                    }
                    Spacer(modifier = Modifier.height(2.dp))
                    Text(
                        text = "Peak ${Formatters.formatSpeed(snapshot.peakSpeed)}",
                        color = TextMuted,
                        fontSize = 10.5.sp,
                        fontFamily = FontFamily.Monospace
                    )
                }

                Box(modifier = Modifier.width(1.dp).height(76.dp).background(BorderDark))

                Column(
                    modifier = Modifier
                        .weight(1f)
                        .padding(12.dp)
                ) {
                    Text("Upload", color = TextMuted, fontSize = 11.5.sp)
                    Spacer(modifier = Modifier.height(4.dp))
                    Text(
                        text = if (snapshot.totalUpSpeed > 0) Formatters.formatSpeed(snapshot.totalUpSpeed) else "—",
                        color = TextPrimary,
                        fontSize = 15.sp,
                        fontWeight = FontWeight.SemiBold,
                        fontFamily = FontFamily.Monospace
                    )
                    Spacer(modifier = Modifier.height(2.dp))
                    Text(
                        text = "$totalPeers active peers",
                        color = TextMuted,
                        fontSize = 10.5.sp,
                        fontFamily = FontFamily.Monospace
                    )
                }
            }

            HorizontalDivider(color = BorderDark, thickness = 1.dp)

            Row(modifier = Modifier.fillMaxWidth()) {
                Column(
                    modifier = Modifier
                        .weight(1f)
                        .padding(12.dp)
                ) {
                    Text("Routing", color = TextMuted, fontSize = 11.5.sp)
                    Spacer(modifier = Modifier.height(4.dp))
                    Text(
                        text = "${snapshot.bondedCount} of ${snapshot.connectedCount} active",
                        color = TextPrimary,
                        fontSize = 14.5.sp,
                        fontWeight = FontWeight.SemiBold,
                        fontFamily = FontFamily.Monospace
                    )
                    Spacer(modifier = Modifier.height(2.dp))
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(5.dp)) {
                        Box(
                            modifier = Modifier
                                .size(6.dp)
                                .clip(CircleShape)
                                .background(if (snapshot.bondedCount > 1) OkGreen else AccentBlue)
                        )
                        Text(
                            text = if (snapshot.bondedCount > 1) "Multi-interface bonding" else "Single interface",
                            color = TextSecondary,
                            fontSize = 10.5.sp,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis
                        )
                    }
                }

                Box(modifier = Modifier.width(1.dp).height(76.dp).background(BorderDark))

                Column(
                    modifier = Modifier
                        .weight(1f)
                        .padding(12.dp)
                ) {
                    Text("Session transferred", color = TextMuted, fontSize = 11.5.sp)
                    Spacer(modifier = Modifier.height(4.dp))
                    Text(
                        text = Formatters.formatBytes(snapshot.totalDownloaded),
                        color = TextPrimary,
                        fontSize = 14.5.sp,
                        fontWeight = FontWeight.SemiBold,
                        fontFamily = FontFamily.Monospace
                    )
                    Spacer(modifier = Modifier.height(2.dp))
                    Text(
                        text = "${Formatters.formatBytes(snapshot.totalUploaded)} uploaded",
                        color = TextMuted,
                        fontSize = 10.5.sp,
                        fontFamily = FontFamily.Monospace
                    )
                }
            }
        }

        Spacer(modifier = Modifier.height(16.dp))

        Text(
            text = "Interfaces  ·  Toggle routing per interface (Wi-Fi + 5G/LTE)",
            color = TextSecondary,
            fontSize = 12.sp,
            fontWeight = FontWeight.Medium
        )

        Spacer(modifier = Modifier.height(8.dp))

        Column(
            modifier = Modifier
                .fillMaxWidth()
                .border(1.dp, BorderDark, RoundedCornerShape(6.dp))
                .background(SurfaceDark, RoundedCornerShape(6.dp))
        ) {
            snapshot.interfaces.forEachIndexed { idx, iface ->
                val dotColor = when {
                    !iface.connected -> TextMuted
                    iface.type == "cellular" -> OkGreen
                    else -> AccentBlue
                }

                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(12.dp)
                ) {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Row(
                            modifier = Modifier
                                .weight(1f)
                                .padding(end = 8.dp),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(8.dp)
                        ) {
                            Box(
                                modifier = Modifier
                                    .size(7.dp)
                                    .clip(CircleShape)
                                    .background(dotColor)
                            )
                            Text(
                                text = iface.name,
                                color = TextPrimary,
                                fontSize = 13.5.sp,
                                fontWeight = FontWeight.Medium,
                                maxLines = 1
                            )
                            Text(
                                text = iface.device,
                                color = TextMuted,
                                fontSize = 11.sp,
                                fontFamily = FontFamily.Monospace,
                                maxLines = 1
                            )
                        }

                        // Interactive Toggle Switch Pill for Routing
                        val isOn = iface.enabled && iface.connected
                        Row(
                            modifier = Modifier
                                .clip(RoundedCornerShape(6.dp))
                                .border(
                                    1.dp,
                                    if (isOn) dotColor.copy(alpha = 0.6f) else BorderDark,
                                    RoundedCornerShape(6.dp)
                                )
                                .background(Surface2Dark)
                                .clickable(enabled = iface.connected) {
                                    SvorrentEngine.setAdapterRouting(iface.id, !iface.enabled)
                                }
                                .padding(horizontal = 9.dp, vertical = 5.dp),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(7.dp)
                        ) {
                            Text(
                                text = when {
                                    !iface.connected -> "Offline"
                                    isOn -> "Routing"
                                    else -> "Muted"
                                },
                                color = if (isOn) TextPrimary else TextMuted,
                                fontSize = 11.sp,
                                fontFamily = FontFamily.Monospace
                            )
                            MiniToggleSwitch(
                                checked = isOn,
                                activeColor = dotColor,
                                enabled = iface.connected
                            )
                        }
                    }

                    Spacer(modifier = Modifier.height(6.dp))

                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Text(
                            text = "IPv4: ${iface.ip}",
                            color = TextSecondary,
                            fontSize = 11.5.sp,
                            fontFamily = FontFamily.Monospace
                        )
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(8.dp)
                        ) {
                            Text(
                                text = if (iface.downSpeed > 0) "↓ ${Formatters.formatSpeed(iface.downSpeed)}" else "↓ —",
                                color = TextPrimary,
                                fontSize = 12.sp,
                                fontFamily = FontFamily.Monospace
                            )
                            MiniSparkline(data = iface.history, color = dotColor, width = 52.dp, height = 14.dp)
                        }
                    }

                    Spacer(modifier = Modifier.height(4.dp))

                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween
                    ) {
                        Text(
                            text = "↑ ${if (iface.upSpeed > 0) Formatters.formatSpeed(iface.upSpeed) else "—"}",
                            color = TextMuted,
                            fontSize = 11.sp,
                            fontFamily = FontFamily.Monospace
                        )
                        Text(
                            text = "Share: ${if (iface.sharePercent > 0) "${iface.sharePercent}%" else "—"} · ${Formatters.formatBytes(iface.downloaded)} · ${iface.peers}p",
                            color = TextSecondary,
                            fontSize = 11.sp,
                            fontFamily = FontFamily.Monospace
                        )
                    }
                }

                if (idx < snapshot.interfaces.lastIndex) {
                    HorizontalDivider(color = BorderDark, thickness = 1.dp)
                }
            }
        }

        Spacer(modifier = Modifier.height(16.dp))

        Text(
            text = "Application & Updates",
            color = TextSecondary,
            fontSize = 12.sp,
            fontWeight = FontWeight.Medium
        )

        Spacer(modifier = Modifier.height(8.dp))

        Row(
            modifier = Modifier
                .fillMaxWidth()
                .border(1.dp, BorderDark, RoundedCornerShape(6.dp))
                .background(SurfaceDark, RoundedCornerShape(6.dp))
                .padding(12.dp),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Column(
                modifier = Modifier
                    .weight(1f)
                    .padding(end = 8.dp)
            ) {
                Text(
                    text = "Svorrent v${updateState.currentVersion} (${updateState.currentSha})",
                    color = TextPrimary,
                    fontSize = 12.5.sp,
                    fontFamily = FontFamily.Monospace
                )
                Text(
                    text = updateState.latestMessage,
                    color = TextSecondary,
                    fontSize = 11.sp,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis
                )
            }

            CompactActionBtn(
                label = "Updates",
                onClick = onOpenUpdateModal
            )
        }
    }
}

@Composable
fun UpdateDialog(
    updateState: UpdateState,
    onCheckNow: () -> Unit,
    onDownloadAndInstall: (String) -> Unit,
    onInstallDownloaded: () -> Unit,
    onOpenBrowserDownload: () -> Unit,
    onDownloadLatestApk: () -> Unit,
    onDismiss: () -> Unit
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        containerColor = SurfaceDark,
        title = {
            Text(
                text = "Svorrent Android Updates",
                color = TextPrimary,
                fontSize = 15.sp,
                fontWeight = FontWeight.SemiBold
            )
        },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(
                    text = "Installed: v${updateState.currentVersion} (commit ${updateState.currentSha})",
                    color = TextPrimary,
                    fontSize = 12.sp,
                    fontFamily = FontFamily.Monospace
                )
                Text(
                    text = updateState.latestMessage,
                    color = TextSecondary,
                    fontSize = 12.sp
                )
                Text(
                    text = when (updateState.status) {
                        "ready" -> "The update APK has been downloaded. Tap “Install Update” to proceed with system installation."
                        "downloading" -> "Downloading Svorrent.apk update from GitHub Releases…"
                        "available" -> "A newer version of Svorrent is available. Tap “Download & Install” to update."
                        else -> "Your app is running the latest build. Tap “Download Latest APK” below to manually re-download if needed."
                    },
                    color = TextMuted,
                    fontSize = 11.5.sp
                )
                if (updateState.status == "downloading") {
                    LinearProgressIndicator(
                        progress = { updateState.downloadProgress / 100f },
                        modifier = Modifier.fillMaxWidth(),
                        color = AccentBlue,
                        trackColor = Surface2Dark
                    )
                }
            }
        },
        confirmButton = {
            when {
                updateState.status == "ready" -> {
                    Button(
                        onClick = onInstallDownloaded,
                        colors = ButtonDefaults.buttonColors(containerColor = AccentBlue, contentColor = TextPrimary)
                    ) {
                        Text("Install Update", fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
                    }
                }
                updateState.status == "downloading" -> {
                    Button(
                        onClick = {},
                        enabled = false,
                        colors = ButtonDefaults.buttonColors(containerColor = AccentBlue.copy(alpha = 0.5f), contentColor = TextPrimary)
                    ) {
                        Text("Downloading… ${updateState.downloadProgress}%", fontSize = 12.sp)
                    }
                }
                updateState.status == "available" && updateState.apkDownloadUrl != null -> {
                    Button(
                        onClick = { onDownloadAndInstall(updateState.apkDownloadUrl) },
                        colors = ButtonDefaults.buttonColors(containerColor = AccentBlue, contentColor = TextPrimary)
                    ) {
                        Text("Download & Install", fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
                    }
                }
                else -> {
                    Button(
                        onClick = onDownloadLatestApk,
                        colors = ButtonDefaults.buttonColors(containerColor = TextPrimary, contentColor = BgDark)
                    ) {
                        Text("Download Latest APK", fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
                    }
                }
            }
        },
        dismissButton = {
            Row(
                horizontalArrangement = Arrangement.spacedBy(4.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                TextButton(onClick = onOpenBrowserDownload) {
                    Text("Browser", color = AccentBlue)
                }
                TextButton(
                    onClick = onCheckNow,
                    enabled = updateState.status != "checking" && updateState.status != "downloading"
                ) {
                    Text(if (updateState.status == "checking") "Checking…" else "Check", color = AccentBlue)
                }
                TextButton(onClick = onDismiss) {
                    Text("Close", color = TextSecondary)
                }
            }
        }
    )
}

@Composable
fun SwarmInspectorDialog(
    torrent: TorrentItem,
    onDismiss: () -> Unit
) {
    DisposableEffect(torrent.infoHash) {
        SvorrentEngine.inspectedSwarmHash = torrent.infoHash
        onDispose {
            SvorrentEngine.inspectedSwarmHash = null
        }
    }

    val swarm = SvorrentEngine.getSwarmSnapshot(torrent.infoHash)
    val telemetry = swarm?.pieceTelemetry
    val peers = swarm?.peers ?: emptyList()

    Dialog(
        onDismissRequest = onDismiss,
        properties = DialogProperties(usePlatformDefaultWidth = false)
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth(0.95f)
                .fillMaxHeight(0.84f)
                .border(1.dp, BorderStrong, RoundedCornerShape(8.dp))
                .background(BgDark, RoundedCornerShape(8.dp))
                .padding(14.dp)
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Column(modifier = Modifier.weight(1f)) {
                    Text(
                        text = torrent.name,
                        color = TextPrimary,
                        fontSize = 14.5.sp,
                        fontWeight = FontWeight.SemiBold,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis
                    )
                    Text(
                        text = "${Formatters.formatBytes(torrent.length)} · ${String.format("%.1f", torrent.progress * 100f)}% · ↓ ${Formatters.formatSpeed(torrent.downloadSpeed)} · ${peers.size} peers",
                        color = TextSecondary,
                        fontSize = 11.5.sp,
                        fontFamily = FontFamily.Monospace
                    )
                }
                IconButton(onClick = onDismiss) {
                    Icon(Icons.Default.Close, contentDescription = "Close", tint = TextSecondary)
                }
            }

            HorizontalDivider(color = BorderDark, modifier = Modifier.padding(vertical = 8.dp))

            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .border(1.dp, BorderDark, RoundedCornerShape(6.dp))
                    .background(SurfaceDark, RoundedCornerShape(6.dp))
                    .padding(10.dp)
            ) {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween
                ) {
                    Text("Piece map", color = TextPrimary, fontSize = 12.sp, fontWeight = FontWeight.Medium)
                    if (telemetry != null) {
                        Text(
                            text = "${telemetry.verifiedPieces} / ${telemetry.totalPieces} verified · ${telemetry.progressPercent}%",
                            color = TextMuted,
                            fontSize = 11.sp,
                            fontFamily = FontFamily.Monospace
                        )
                    }
                }

                Spacer(modifier = Modifier.height(8.dp))

                Canvas(
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(26.dp)
                        .clip(RoundedCornerShape(3.dp))
                        .background(BgDark)
                ) {
                    if (size.width <= 0f || size.height <= 0f) return@Canvas
                    val grid = telemetry?.piecesGrid?.takeIf { it.isNotEmpty() } ?: List(120) { 0 }
                    val n = grid.size.coerceAtLeast(1)
                    val barW = size.width / n.toFloat()
                    grid.forEachIndexed { idx, state ->
                        val color = when (state) {
                            2 -> OkGreen
                            1 -> AccentBlue
                            else -> Surface2Dark
                        }
                        drawRect(
                            color = color,
                            topLeft = Offset(idx * barW, 2f),
                            size = androidx.compose.ui.geometry.Size(
                                (barW - 1.2f).coerceAtLeast(1f),
                                (size.height - 4f).coerceAtLeast(1f)
                            )
                        )
                    }
                }

                Spacer(modifier = Modifier.height(6.dp))

                Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    Text("■ Verified (Green)", color = OkGreen, fontSize = 10.5.sp)
                    Text("■ Active (Blue)", color = AccentBlue, fontSize = 10.5.sp)
                    Text("■ Missing", color = TextMuted, fontSize = 10.5.sp)
                }
            }

            Spacer(modifier = Modifier.height(10.dp))

            Text(
                text = "Connected Peers (${peers.size})",
                color = TextPrimary,
                fontSize = 12.5.sp,
                fontWeight = FontWeight.Medium
            )

            Spacer(modifier = Modifier.height(6.dp))

            if (peers.isEmpty()) {
                Box(
                    modifier = Modifier
                        .fillMaxSize()
                        .border(1.dp, BorderDark, RoundedCornerShape(6.dp))
                        .background(SurfaceDark, RoundedCornerShape(6.dp)),
                    contentAlignment = Alignment.Center
                ) {
                    Text("Connecting to swarm peers…", color = TextMuted, fontSize = 12.5.sp)
                }
            } else {
                LazyColumn(
                    modifier = Modifier
                        .fillMaxSize()
                        .border(1.dp, BorderDark, RoundedCornerShape(6.dp))
                        .background(SurfaceDark, RoundedCornerShape(6.dp))
                ) {
                    itemsIndexed(peers, key = { idx, p -> "${p.ip}:${p.port}:$idx" }) { _, p ->
                        val ifaceColor = if (p.networkType == "cellular") OkGreen else AccentBlue
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(horizontal = 10.dp, vertical = 8.dp),
                            horizontalArrangement = Arrangement.SpaceBetween,
                            verticalAlignment = Alignment.CenterVertically
                        ) {
                            Column(
                                modifier = Modifier
                                    .weight(1f)
                                    .padding(end = 8.dp)
                            ) {
                                Text(
                                    text = "${p.ip}:${p.port}",
                                    color = TextPrimary,
                                    fontSize = 12.sp,
                                    fontFamily = FontFamily.Monospace
                                )
                                Row(
                                    verticalAlignment = Alignment.CenterVertically,
                                    horizontalArrangement = Arrangement.spacedBy(5.dp)
                                ) {
                                    Box(
                                        modifier = Modifier
                                            .size(6.dp)
                                            .clip(CircleShape)
                                            .background(ifaceColor)
                                    )
                                    Text(
                                        text = "${p.networkInterface} · ${p.client}",
                                        color = TextMuted,
                                        fontSize = 11.sp,
                                        maxLines = 1,
                                        overflow = TextOverflow.Ellipsis
                                    )
                                }
                            }
                            Column(horizontalAlignment = Alignment.End) {
                                Text(
                                    text = "↓ ${Formatters.formatSpeed(p.downloadSpeed)}",
                                    color = if (p.downloadSpeed > 0) OkGreen else TextSecondary,
                                    fontSize = 12.sp,
                                    fontFamily = FontFamily.Monospace
                                )
                                Text(
                                    text = "↑ ${Formatters.formatSpeed(p.uploadSpeed)} · ${p.progressPercent}%",
                                    color = TextMuted,
                                    fontSize = 10.5.sp,
                                    fontFamily = FontFamily.Monospace
                                )
                            }
                        }
                        HorizontalDivider(color = BorderDark, thickness = 1.dp)
                    }
                }
            }
        }
    }
}

@Composable
fun TorrentDetailsDialog(
    torrent: TorrentItem,
    onDismiss: () -> Unit
) {
    Dialog(
        onDismissRequest = onDismiss,
        properties = DialogProperties(usePlatformDefaultWidth = false)
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth(0.94f)
                .fillMaxHeight(0.80f)
                .border(1.dp, BorderStrong, RoundedCornerShape(8.dp))
                .background(BgDark, RoundedCornerShape(8.dp))
                .padding(14.dp)
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text(
                    text = "Torrent Details",
                    color = TextPrimary,
                    fontSize = 15.sp,
                    fontWeight = FontWeight.SemiBold
                )
                IconButton(onClick = onDismiss) {
                    Icon(Icons.Default.Close, contentDescription = "Close", tint = TextSecondary)
                }
            }

            Text(
                text = "InfoHash: ${torrent.infoHash}",
                color = TextMuted,
                fontSize = 11.sp,
                fontFamily = FontFamily.Monospace
            )
            Text(
                text = "Path: ${torrent.savePath}",
                color = TextMuted,
                fontSize = 11.sp,
                fontFamily = FontFamily.Monospace
            )

            Spacer(modifier = Modifier.height(8.dp))

            CompactActionBtn(
                label = "↻ Force Recheck Pieces",
                onClick = { SvorrentEngine.forceRecheck(torrent.infoHash) }
            )

            Spacer(modifier = Modifier.height(10.dp))

            Text("Files (${torrent.files.size})", color = TextPrimary, fontSize = 12.5.sp, fontWeight = FontWeight.Medium)
            Spacer(modifier = Modifier.height(6.dp))

            LazyColumn(
                modifier = Modifier
                    .fillMaxSize()
                    .border(1.dp, BorderDark, RoundedCornerShape(6.dp))
                    .background(SurfaceDark, RoundedCornerShape(6.dp))
            ) {
                items(torrent.files) { f ->
                    Column(modifier = Modifier.padding(10.dp)) {
                        Text(f.name, color = TextPrimary, fontSize = 12.5.sp)
                        Spacer(modifier = Modifier.height(4.dp))
                        Text(
                            text = "${Formatters.formatBytes(f.downloaded)} / ${Formatters.formatBytes(f.length)} (${(f.progress * 100f).toInt()}%)",
                            color = TextSecondary,
                            fontSize = 11.sp,
                            fontFamily = FontFamily.Monospace
                        )
                    }
                    HorizontalDivider(color = BorderDark, thickness = 1.dp)
                }
            }
        }
    }
}

private fun launchVideoPlayer(context: Context, file: File) {
    if (!file.exists()) {
        Toast.makeText(context, "Video file is still being created on disk…", Toast.LENGTH_SHORT).show()
        return
    }
    try {
        val uri = FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", file)
        val intent = Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(uri, "video/*")
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        context.startActivity(Intent.createChooser(intent, "Play video with"))
    } catch (e: Exception) {
        Toast.makeText(context, "No video player found (install VLC for Android)", Toast.LENGTH_LONG).show()
    }
}
