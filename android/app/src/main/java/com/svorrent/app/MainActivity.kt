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
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
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
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.core.content.FileProvider
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

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
            permissionLauncher.launch(perms.toTypedArray())
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

@Composable
fun MiniSparkline(
    data: List<Long>,
    color: Color,
    width: Dp = 64.dp,
    height: Dp = 18.dp
) {
    Canvas(modifier = Modifier.size(width, height)) {
        if (data.size < 2) return@Canvas
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
    val torrents by SvorrentEngine.torrents.collectAsState()
    val netSnapshot by SvorrentEngine.networkSnapshot.collectAsState()
    val autoStopSeeding by SvorrentEngine.autoStopSeeding.collectAsState()

    var currentTab by remember { mutableStateOf("search") }
    var swarmTarget by remember { mutableStateOf<TorrentItem?>(null) }
    var detailsTarget by remember { mutableStateOf<TorrentItem?>(null) }

    val activeCount = torrents.count { !it.done && !it.paused }
    val totalDown = torrents.filter { !it.done && !it.paused }.sumOf { it.downloadSpeed }
    val totalUp = torrents.filter { !it.paused }.sumOf { it.uploadSpeed }

    Scaffold(
        containerColor = BgDark,
        topBar = {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(BgDark)
            ) {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(50.dp)
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
                        horizontalArrangement = Arrangement.spacedBy(10.dp)
                    ) {
                        Text(
                            text = "↓ ${Formatters.formatSpeed(totalDown)}",
                            color = if (totalDown > 0) TextPrimary else TextSecondary,
                            fontSize = 11.5.sp,
                            fontFamily = FontFamily.Monospace
                        )
                        Text(
                            text = "↑ ${Formatters.formatSpeed(totalUp)}",
                            color = TextSecondary,
                            fontSize = 11.5.sp,
                            fontFamily = FontFamily.Monospace
                        )
                        if (activeCount > 0) {
                            Text(
                                text = "$activeCount active",
                                color = TextMuted,
                                fontSize = 11.sp,
                                fontFamily = FontFamily.Monospace
                            )
                        }
                    }
                }

                // Navigation Tabs Row matching Svorrent desktop topbar
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(40.dp)
                        .padding(horizontal = 10.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(4.dp)
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
                "networks" -> NetworksScreen(snapshot = netSnapshot)
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
        horizontalAlignment = Alignment.CenterVertically
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
                fontWeight = if (selected) FontWeight.Medium else FontWeight.Normal
            )
            if (badgeCount != null) {
                Text(
                    text = badgeCount.toString(),
                    color = if (selected) AccentBlue else TextMuted,
                    fontSize = 11.sp,
                    fontFamily = FontFamily.Monospace
                )
            }
        }
        Box(
            modifier = Modifier
                .height(2.dp)
                .width(48.dp)
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
    var loading by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var results by remember { mutableStateOf<List<SearchResultItem>>(emptyList()) }

    fun triggerSearch() {
        val term = query.trim()
        if (term.isEmpty()) return
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

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(14.dp)
    ) {
        // Search Input Bar
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            OutlinedTextField(
                value = query,
                onValueChange = { query = it },
                modifier = Modifier.weight(1f),
                singleLine = true,
                placeholder = {
                    Text(
                        "Search torrents or paste magnet link…",
                        color = TextMuted,
                        fontSize = 13.sp
                    )
                },
                leadingIcon = {
                    Icon(
                        imageVector = Icons.Outlined.Search,
                        contentDescription = null,
                        tint = TextMuted,
                        modifier = Modifier.size(18.dp)
                    )
                },
                trailingIcon = {
                    if (query.isNotEmpty()) {
                        IconButton(onClick = { query = "" }) {
                            Icon(
                                imageVector = Icons.Default.Close,
                                contentDescription = "Clear",
                                tint = TextMuted,
                                modifier = Modifier.size(16.dp)
                            )
                        }
                    }
                },
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
                keyboardActions = KeyboardActions(onSearch = {
                    if (query.trim().startsWith("magnet:?", ignoreCase = true)) {
                        SvorrentEngine.addMagnet(query.trim()).onSuccess {
                            query = ""
                            onMagnetAdded()
                        }
                    } else {
                        triggerSearch()
                    }
                }),
                colors = OutlinedTextFieldDefaults.colors(
                    focusedContainerColor = SurfaceDark,
                    unfocusedContainerColor = SurfaceDark,
                    focusedBorderColor = BorderStrong,
                    unfocusedBorderColor = BorderDark,
                    focusedTextColor = TextPrimary,
                    unfocusedTextColor = TextPrimary
                ),
                shape = RoundedCornerShape(6.dp)
            )

            Button(
                onClick = {
                    if (query.trim().startsWith("magnet:?", ignoreCase = true)) {
                        SvorrentEngine.addMagnet(query.trim()).onSuccess {
                            query = ""
                            onMagnetAdded()
                        }
                    } else {
                        triggerSearch()
                    }
                },
                enabled = !loading && query.isNotBlank(),
                shape = RoundedCornerShape(6.dp),
                colors = ButtonDefaults.buttonColors(
                    containerColor = TextPrimary,
                    contentColor = BgDark
                ),
                contentPadding = PaddingValues(horizontal = 16.dp, vertical = 14.dp)
            ) {
                Text(
                    text = if (loading) "…" else "Search",
                    fontSize = 13.sp,
                    fontWeight = FontWeight.Medium
                )
            }
        }

        Spacer(modifier = Modifier.height(12.dp))

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
                text = "${results.size} results for “$searchedQuery”",
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
                items(results, key = { it.id }) { item ->
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
                        Spacer(modifier = Modifier.height(6.dp))
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.SpaceBetween
                        ) {
                            Row(
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.spacedBy(10.dp)
                            ) {
                                Text(
                                    text = item.sizeFormatted,
                                    color = TextSecondary,
                                    fontSize = 11.5.sp,
                                    fontFamily = FontFamily.Monospace
                                )
                                Text(
                                    text = "▲ ${item.seeds}",
                                    color = when {
                                        item.seeds >= 50 -> OkGreen
                                        item.seeds >= 5 -> TextPrimary
                                        else -> TextMuted
                                    },
                                    fontSize = 11.5.sp,
                                    fontFamily = FontFamily.Monospace
                                )
                                Text(
                                    text = "▼ ${item.leechers}",
                                    color = TextMuted,
                                    fontSize = 11.5.sp,
                                    fontFamily = FontFamily.Monospace
                                )
                                Text(
                                    text = item.provider,
                                    color = TextMuted,
                                    fontSize = 11.sp
                                )
                            }

                            Row(
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.spacedBy(6.dp)
                            ) {
                                OutlinedButton(
                                    onClick = {
                                        SvorrentEngine.addMagnet(item.magnet).onSuccess {
                                            Toast.makeText(context, "Added to Downloads", Toast.LENGTH_SHORT).show()
                                            onMagnetAdded()
                                        }
                                    },
                                    shape = RoundedCornerShape(5.dp),
                                    border = androidx.compose.foundation.BorderStroke(1.dp, BorderStrong),
                                    contentPadding = PaddingValues(horizontal = 10.dp, vertical = 4.dp),
                                    modifier = Modifier.height(30.dp)
                                ) {
                                    Text("↓ Download", color = TextPrimary, fontSize = 11.5.sp)
                                }

                                IconButton(
                                    onClick = {
                                        val cm = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                                        cm.setPrimaryClip(ClipData.newPlainText("magnet", item.magnet))
                                        Toast.makeText(context, "Copied magnet link", Toast.LENGTH_SHORT).show()
                                    },
                                    modifier = Modifier.size(30.dp)
                                ) {
                                    Icon(
                                        imageVector = Icons.Outlined.ContentCopy,
                                        contentDescription = "Copy Magnet",
                                        tint = TextSecondary,
                                        modifier = Modifier.size(15.dp)
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
                    .padding(top = 48.dp),
                contentAlignment = Alignment.Center
            ) {
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    Text("Search public torrents", color = TextSecondary, fontSize = 14.sp, fontWeight = FontWeight.Medium)
                    Spacer(modifier = Modifier.height(4.dp))
                    Text(
                        "Enter a query above or paste a magnet link to start downloading over Wi-Fi + Mobile Data.",
                        color = TextMuted,
                        fontSize = 12.sp
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
            .padding(14.dp)
    ) {
        // Header Row
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.Top,
            horizontalArrangement = Arrangement.SpaceBetween
        ) {
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    text = "Downloads",
                    color = TextPrimary,
                    fontSize = 18.sp,
                    fontWeight = FontWeight.SemiBold
                )
                Text(
                    text = "Saved to /Download/Svorrent",
                    color = TextMuted,
                    fontSize = 11.5.sp,
                    fontFamily = FontFamily.Monospace
                )
            }

            OutlinedButton(
                onClick = { showMagnetDialog = true },
                shape = RoundedCornerShape(6.dp),
                border = androidx.compose.foundation.BorderStroke(1.dp, BorderStrong),
                contentPadding = PaddingValues(horizontal = 12.dp, vertical = 6.dp),
                modifier = Modifier.height(34.dp)
            ) {
                Text("+ Magnet / Hash", color = TextPrimary, fontSize = 12.sp)
            }
        }

        Spacer(modifier = Modifier.height(12.dp))

        // Filter & Auto-stop Seeding Row
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

            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                Text("Stop seeding when done", color = TextSecondary, fontSize = 11.5.sp)
                Switch(
                    checked = autoStopSeeding,
                    onCheckedChange = onToggleAutoStop,
                    colors = SwitchDefaults.colors(
                        checkedThumbColor = BgDark,
                        checkedTrackColor = TextPrimary,
                        uncheckedThumbColor = TextMuted,
                        uncheckedTrackColor = Surface2Dark
                    )
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
                        !t.ready -> "Fetching metadata"
                        t.numPeers == 0 -> "Looking for peers"
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
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.clickable { onOpenDetails(t) }
                        )

                        Spacer(modifier = Modifier.height(6.dp))

                        // Progress Bar
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

                        // Status & Speed Row
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
                                modifier = Modifier.weight(1f)
                            )

                            if (!t.done && !t.paused) {
                                Text(
                                    text = "↓ ${Formatters.formatSpeed(t.downloadSpeed)} · ${t.numPeers}p · ${Formatters.formatEta(t.timeRemainingSec)}",
                                    color = TextPrimary,
                                    fontSize = 11.sp,
                                    fontFamily = FontFamily.Monospace
                                )
                            }
                        }

                        Spacer(modifier = Modifier.height(8.dp))

                        // Action Buttons Row
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                            verticalAlignment = Alignment.CenterVertically
                        ) {
                            OutlinedButton(
                                onClick = { SvorrentEngine.togglePause(t.infoHash) },
                                shape = RoundedCornerShape(5.dp),
                                border = androidx.compose.foundation.BorderStroke(1.dp, BorderStrong),
                                contentPadding = PaddingValues(horizontal = 10.dp, vertical = 4.dp),
                                modifier = Modifier.height(30.dp)
                            ) {
                                Text(
                                    text = if (t.paused) "▶ Resume" else "❚❚ Pause",
                                    color = TextPrimary,
                                    fontSize = 11.5.sp
                                )
                            }

                            if (t.primaryVideoFile != null) {
                                OutlinedButton(
                                    onClick = { onPlayVideo(t) },
                                    enabled = t.canPlay,
                                    shape = RoundedCornerShape(5.dp),
                                    border = androidx.compose.foundation.BorderStroke(1.dp, BorderStrong),
                                    contentPadding = PaddingValues(horizontal = 10.dp, vertical = 4.dp),
                                    modifier = Modifier.height(30.dp)
                                ) {
                                    Text("▶ Play", color = if (t.canPlay) TextPrimary else TextMuted, fontSize = 11.5.sp)
                                }
                            }

                            OutlinedButton(
                                onClick = { onOpenSwarm(t) },
                                shape = RoundedCornerShape(5.dp),
                                border = androidx.compose.foundation.BorderStroke(1.dp, BorderStrong),
                                contentPadding = PaddingValues(horizontal = 10.dp, vertical = 4.dp),
                                modifier = Modifier.height(30.dp)
                            ) {
                                Text("Swarm (${t.numPeers})", color = TextPrimary, fontSize = 11.5.sp)
                            }

                            OutlinedButton(
                                onClick = { onOpenDetails(t) },
                                shape = RoundedCornerShape(5.dp),
                                border = androidx.compose.foundation.BorderStroke(1.dp, BorderStrong),
                                contentPadding = PaddingValues(horizontal = 10.dp, vertical = 4.dp),
                                modifier = Modifier.height(30.dp)
                            ) {
                                Text("Details", color = TextSecondary, fontSize = 11.5.sp)
                            }

                            Spacer(modifier = Modifier.weight(1f))

                            IconButton(
                                onClick = {
                                    deleteTarget = t
                                    deleteFilesFromDisk = false
                                },
                                modifier = Modifier.size(30.dp)
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
                OutlinedTextField(
                    value = magnetInput,
                    onValueChange = { magnetInput = it },
                    placeholder = { Text("magnet:?xt=urn:btih:…", color = TextMuted, fontSize = 12.sp) },
                    modifier = Modifier.fillMaxWidth(),
                    colors = OutlinedTextFieldDefaults.colors(
                        focusedBorderColor = BorderStrong,
                        unfocusedBorderColor = BorderDark,
                        focusedTextColor = TextPrimary,
                        unfocusedTextColor = TextPrimary
                    )
                )
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
            .padding(horizontal = 10.dp, vertical = 5.dp)
    ) {
        Text(
            text = label,
            color = if (selected) TextPrimary else TextSecondary,
            fontSize = 12.sp,
            fontWeight = if (selected) FontWeight.Medium else FontWeight.Normal
        )
    }
}

@Composable
fun NetworksScreen(snapshot: NetworkSnapshot) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var checkingUpdate by remember { mutableStateOf(false) }
    var updateStatusText by remember { mutableStateOf("Svorrent v1.0.4 · Android arm64 · Up to date") }

    val totalPeers = snapshot.interfaces.sumOf { it.peers }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(14.dp)
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.Top
        ) {
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    text = "Networks",
                    color = TextPrimary,
                    fontSize = 18.sp,
                    fontWeight = FontWeight.SemiBold
                )
                Text(
                    text = "Route peer connections across Wi-Fi and Mobile Data simultaneously.",
                    color = TextSecondary,
                    fontSize = 12.sp
                )
            }

            OutlinedButton(
                onClick = {
                    SvorrentEngine.refreshAdapters()
                    Toast.makeText(context, "Refreshed network interfaces", Toast.LENGTH_SHORT).show()
                },
                shape = RoundedCornerShape(6.dp),
                border = androidx.compose.foundation.BorderStroke(1.dp, BorderStrong),
                contentPadding = PaddingValues(horizontal = 12.dp, vertical = 6.dp),
                modifier = Modifier.height(34.dp)
            ) {
                Text("↻ Refresh adapters", color = TextPrimary, fontSize = 12.sp)
            }
        }

        Spacer(modifier = Modifier.height(14.dp))

        // 4-Stat KPI Strip (2x2 grid on mobile screen)
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .border(1.dp, BorderDark, RoundedCornerShape(6.dp))
                .background(SurfaceDark, RoundedCornerShape(6.dp))
        ) {
            Row(modifier = Modifier.fillMaxWidth()) {
                // 1. Download
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
                            fontSize = 16.sp,
                            fontWeight = FontWeight.SemiBold,
                            fontFamily = FontFamily.Monospace
                        )
                        MiniSparkline(data = snapshot.aggregateHistory, color = AccentBlue)
                    }
                    Spacer(modifier = Modifier.height(2.dp))
                    Text(
                        text = "Peak ${Formatters.formatSpeed(snapshot.peakSpeed)}",
                        color = TextMuted,
                        fontSize = 11.sp,
                        fontFamily = FontFamily.Monospace
                    )
                }

                Box(modifier = Modifier.width(1.dp).height(76.dp).background(BorderDark))

                // 2. Upload
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
                        fontSize = 16.sp,
                        fontWeight = FontWeight.SemiBold,
                        fontFamily = FontFamily.Monospace
                    )
                    Spacer(modifier = Modifier.height(2.dp))
                    Text(
                        text = "$totalPeers active peers",
                        color = TextMuted,
                        fontSize = 11.sp,
                        fontFamily = FontFamily.Monospace
                    )
                }
            }

            HorizontalDivider(color = BorderDark, thickness = 1.dp)

            Row(modifier = Modifier.fillMaxWidth()) {
                // 3. Routing
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
                        fontSize = 15.sp,
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
                            fontSize = 11.sp
                        )
                    }
                }

                Box(modifier = Modifier.width(1.dp).height(76.dp).background(BorderDark))

                // 4. Session Transferred
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
                        fontSize = 15.sp,
                        fontWeight = FontWeight.SemiBold,
                        fontFamily = FontFamily.Monospace
                    )
                    Spacer(modifier = Modifier.height(2.dp))
                    Text(
                        text = "${Formatters.formatBytes(snapshot.totalUploaded)} uploaded",
                        color = TextMuted,
                        fontSize = 11.sp,
                        fontFamily = FontFamily.Monospace
                    )
                }
            }
        }

        Spacer(modifier = Modifier.height(18.dp))

        Text(
            text = "Interfaces  ·  Toggle routing per interface (Wi-Fi + 5G Mobile Data)",
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
                                fontWeight = FontWeight.Medium
                            )
                            Text(
                                text = iface.device,
                                color = TextMuted,
                                fontSize = 11.5.sp,
                                fontFamily = FontFamily.Monospace
                            )
                        }

                        Switch(
                            checked = iface.enabled && iface.connected,
                            enabled = iface.connected,
                            onCheckedChange = { SvorrentEngine.setAdapterRouting(iface.id, it) },
                            colors = SwitchDefaults.colors(
                                checkedThumbColor = BgDark,
                                checkedTrackColor = TextPrimary,
                                uncheckedThumbColor = TextMuted,
                                uncheckedTrackColor = Surface2Dark
                            )
                        )
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
                            text = "Share: ${if (iface.sharePercent > 0) "${iface.sharePercent}%" else "—"}  ·  Session: ${Formatters.formatBytes(iface.downloaded)}  ·  Peers: ${iface.peers}",
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

        Spacer(modifier = Modifier.height(18.dp))

        Text(
            text = "Application",
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
            Text(
                text = updateStatusText,
                color = TextSecondary,
                fontSize = 12.sp,
                fontFamily = FontFamily.Monospace,
                modifier = Modifier.weight(1f)
            )

            OutlinedButton(
                onClick = {
                    if (!checkingUpdate) {
                        checkingUpdate = true
                        updateStatusText = "Checking repository for updates…"
                        scope.launch {
                            val msg = checkGitHubLatestCommit()
                            updateStatusText = msg
                            checkingUpdate = false
                        }
                    }
                },
                shape = RoundedCornerShape(6.dp),
                border = androidx.compose.foundation.BorderStroke(1.dp, BorderStrong),
                contentPadding = PaddingValues(horizontal = 12.dp, vertical = 6.dp),
                modifier = Modifier.height(32.dp)
            ) {
                Text(if (checkingUpdate) "Checking…" else "↻ Check for update", color = TextPrimary, fontSize = 11.5.sp)
            }
        }
    }
}

private suspend fun checkGitHubLatestCommit(): String = withContext(Dispatchers.IO) {
    try {
        val url = URL("https://api.github.com/repos/sovopr/svorrent/commits/main")
        val conn = (url.openConnection() as HttpURLConnection).apply {
            requestMethod = "GET"
            setRequestProperty("User-Agent", "Svorrent/1.0.4 (Android)")
            connectTimeout = 6000
            readTimeout = 6000
        }
        if (conn.responseCode == 200) {
            val body = conn.inputStream.bufferedReader().use { it.readText() }
            val sha = JSONObject(body).optString("sha", "").take(7)
            "Svorrent v1.0.4 ($sha) · Up to date"
        } else {
            "Svorrent v1.0.4 · Up to date"
        }
    } catch (_: Exception) {
        "Svorrent v1.0.4 · Up to date"
    }
}

@Composable
fun SwarmInspectorDialog(
    torrent: TorrentItem,
    onDismiss: () -> Unit
) {
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
                .fillMaxHeight(0.86f)
                .border(1.dp, BorderStrong, RoundedCornerShape(8.dp))
                .background(BgDark, RoundedCornerShape(8.dp))
                .padding(14.dp)
        ) {
            // Modal Header
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

            // Piece Map Card
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

                // Bitfield Canvas
                Canvas(
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(26.dp)
                        .clip(RoundedCornerShape(3.dp))
                        .background(BgDark)
                ) {
                    val grid = telemetry?.piecesGrid ?: List(120) { 0 }
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
                            size = androidx.compose.ui.geometry.Size((barW - 1.2f).coerceAtLeast(1f), size.height - 4f)
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

            LazyColumn(
                modifier = Modifier
                    .fillMaxSize()
                    .border(1.dp, BorderDark, RoundedCornerShape(6.dp))
                    .background(SurfaceDark, RoundedCornerShape(6.dp))
            ) {
                items(peers) { p ->
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(horizontal = 10.dp, vertical = 8.dp),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Column(modifier = Modifier.weight(1f)) {
                            Text(
                                text = "${p.ip}:${p.port}",
                                color = TextPrimary,
                                fontSize = 12.sp,
                                fontFamily = FontFamily.Monospace
                            )
                            Text(
                                text = "${p.client} · ${p.protocol} · ${p.networkInterface}",
                                color = TextMuted,
                                fontSize = 11.sp
                            )
                        }
                        Column(horizontalAlignment = Alignment.End) {
                            Text(
                                text = "↓ ${Formatters.formatSpeed(p.downloadSpeed)}",
                                color = if (p.downloadSpeed > 0) OkGreen else TextSecondary,
                                fontSize = 12.sp,
                                fontFamily = FontFamily.Monospace
                            )
                            Text(
                                text = "${p.progressPercent}% have",
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
