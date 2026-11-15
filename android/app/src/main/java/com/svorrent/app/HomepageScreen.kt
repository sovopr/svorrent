package com.svorrent.app

import android.graphics.BitmapFactory
import android.util.LruCache
import android.widget.Toast
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.outlined.Movie
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

private val HomepageBgDark = Color(0xFF121314)
private val HomepageSurface = Color(0xFF17181A)
private val HomepageSurface2 = Color(0xFF1E2023)
private val HomepageBorder = Color(0xFF26282C)
private val HomepageBorderStrong = Color(0xFF34373D)
private val HomepageTextPrimary = Color(0xFFEDEDEB)
private val HomepageTextSecondary = Color(0xFFA3A4A8)
private val HomepageTextMuted = Color(0xFF6E7076)
private val HomepageAccentBlue = Color(0xFF5B8DEE)
private val HomepageOkGreen = Color(0xFF57AB72)
private val HomepageDangerRed = Color(0xFFE57373)

private object PosterBitmapCache {
    private val cache = LruCache<String, ImageBitmap>(120)

    fun get(url: String): ImageBitmap? = synchronized(cache) { cache.get(url) }

    fun put(url: String, bmp: ImageBitmap) {
        synchronized(cache) { cache.put(url, bmp) }
    }
}

@Composable
private fun RemotePosterImage(
    url: String,
    title: String,
    modifier: Modifier = Modifier
) {
    var bitmap by remember(url) { mutableStateOf(if (url.isNotEmpty()) PosterBitmapCache.get(url) else null) }

    LaunchedEffect(url) {
        if (url.isEmpty() || bitmap != null) return@LaunchedEffect
        if (!DiscoverRepository.isAllowedPosterUrl(url)) return@LaunchedEffect
        val decoded = withContext(Dispatchers.IO) {
            val bytes = SearchRepository.fetchBytesWithLimit(url) ?: return@withContext null
            runCatching { BitmapFactory.decodeByteArray(bytes, 0, bytes.size)?.asImageBitmap() }.getOrNull()
        }
        if (decoded != null) {
            PosterBitmapCache.put(url, decoded)
            bitmap = decoded
        }
    }

    Box(
        modifier = modifier
            .background(HomepageSurface2),
        contentAlignment = Alignment.Center
    ) {
        val bmp = bitmap
        if (bmp != null) {
            Image(
                bitmap = bmp,
                contentDescription = title,
                contentScale = ContentScale.Crop,
                modifier = Modifier.fillMaxSize()
            )
        } else {
            Column(
                modifier = Modifier.padding(8.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(6.dp)
            ) {
                Icon(
                    imageVector = Icons.Outlined.Movie,
                    contentDescription = null,
                    tint = HomepageTextMuted,
                    modifier = Modifier.size(22.dp)
                )
                Text(
                    text = title,
                    color = HomepageTextMuted,
                    fontSize = 10.sp,
                    lineHeight = 12.sp,
                    maxLines = 3,
                    overflow = TextOverflow.Ellipsis,
                    textAlign = TextAlign.Center
                )
            }
        }
    }
}

@Composable
fun HomepageScreen(
    onNavigateToSearch: (String) -> Unit,
    onMagnetAdded: () -> Unit
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val completedHashes by DownloadHistoryManager.completedHashes.collectAsState()
    val liveTorrents by SvorrentEngine.torrents.collectAsState()

    var category by remember { mutableStateOf("movies") }
    var timeWindow by remember { mutableStateOf("7D") }
    var qualityFilter by remember { mutableStateOf("all") }
    var tagFilters by remember { mutableStateOf<Set<String>>(emptySet()) }
    var sourceFilter by remember { mutableStateOf("all") }
    var sortBy by remember { mutableStateOf("trending") }

    val initialCached = remember { DiscoverRepository.getCachedEntry("movies", "7D") }
    var spotlight by remember { mutableStateOf(initialCached?.spotlight ?: emptyList()) }
    var torrents by remember { mutableStateOf(initialCached?.torrents ?: emptyList()) }
    var loading by remember { mutableStateOf(initialCached == null) }
    var refreshing by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var resolvingId by remember { mutableStateOf<String?>(null) }
    var loadGen by remember { mutableStateOf(0) }

    fun loadFeed(cat: String, win: String, forceRefresh: Boolean) {
        val gen = loadGen + 1
        loadGen = gen
        val cached = if (!forceRefresh) DiscoverRepository.getCachedEntry(cat, win) else null
        if (cached != null) {
            spotlight = cached.spotlight
            torrents = cached.torrents
            loading = false
            refreshing = false
            error = null
            return
        }

        if (torrents.isEmpty() || forceRefresh) {
            if (forceRefresh && torrents.isNotEmpty()) {
                refreshing = true
            } else {
                loading = true
            }
        }
        error = null

        scope.launch {
            try {
                val res = DiscoverRepository.discoverTorrents(category = cat, window = win, forceRefresh = forceRefresh)
                if (loadGen == gen) {
                    spotlight = res.spotlight
                    torrents = res.torrents
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Throwable) {
                if (loadGen == gen && torrents.isEmpty()) {
                    error = e.message ?: "Failed to load trending feeds"
                }
            } finally {
                if (loadGen == gen) {
                    loading = false
                    refreshing = false
                }
            }
        }
    }

    LaunchedEffect(category, timeWindow) {
        qualityFilter = "all"
        tagFilters = emptySet()
        sourceFilter = "all"
        loadFeed(category, timeWindow, forceRefresh = false)
    }

    val activeDownloadHashes = remember(liveTorrents) {
        liveTorrents.filter { it.done }.map { it.infoHash }.toSet()
    }

    val sources = remember(torrents) {
        torrents.map { it.provider }.filter { it.isNotBlank() }.distinct()
    }

    val filterCounts = remember(torrents, sourceFilter, qualityFilter, tagFilters) {
        SearchFilterHelper.getFilterCounts(
            results = torrents,
            source = sourceFilter,
            quality = qualityFilter,
            tags = tagFilters
        )
    }

    val filteredTorrents = remember(torrents, sourceFilter, qualityFilter, tagFilters, sortBy) {
        val filtered = SearchFilterHelper.filterResults(
            results = torrents,
            source = sourceFilter,
            quality = qualityFilter,
            tags = tagFilters
        )
        when (sortBy) {
            "seeds" -> filtered.sortedByDescending { it.seeds }
            "size" -> filtered.sortedByDescending { it.sizeBytes }
            else -> filtered
        }
    }

    val hasActiveFilters = qualityFilter != "all" || tagFilters.isNotEmpty() || sourceFilter != "all"

    fun resetFilters() {
        qualityFilter = "all"
        tagFilters = emptySet()
        sourceFilter = "all"
    }

    fun handleDownload(item: SearchResultItem) {
        if (resolvingId != null) return
        if (item.magnet.startsWith("magnet:?xt=urn:btih:", ignoreCase = true) || item.infoHash.length == 40) {
            val mag = item.magnet.ifBlank { SearchRepository.buildMagnetUri(item.infoHash, item.title) }
            SvorrentEngine.addMagnet(mag, preferredTitle = item.title).onSuccess {
                Toast.makeText(context, "Added to Downloads", Toast.LENGTH_SHORT).show()
                onMagnetAdded()
            }.onFailure { err ->
                Toast.makeText(context, err.message ?: "Failed to add magnet", Toast.LENGTH_SHORT).show()
            }
            return
        }

        resolvingId = item.id
        scope.launch {
            try {
                val resolved = runCatching { SearchRepository.resolveMagnet(item) }.getOrDefault("")
                if (resolved.startsWith("magnet:?xt=urn:btih:", ignoreCase = true)) {
                    SvorrentEngine.addMagnet(resolved, preferredTitle = item.title).onSuccess {
                        Toast.makeText(context, "Added to Downloads", Toast.LENGTH_SHORT).show()
                        onMagnetAdded()
                    }.onFailure { err ->
                        Toast.makeText(context, err.message ?: "Failed to add magnet", Toast.LENGTH_SHORT).show()
                    }
                } else {
                    val cleanQ = SearchFilterHelper.cleanReleaseSearchQuery(item.title)
                    Toast.makeText(context, "Searching alternative magnets…", Toast.LENGTH_SHORT).show()
                    onNavigateToSearch(cleanQ)
                }
            } finally {
                if (resolvingId == item.id) {
                    resolvingId = null
                }
            }
        }
    }

    LazyColumn(
        modifier = Modifier
            .fillMaxSize()
            .padding(horizontal = 14.dp),
        contentPadding = PaddingValues(top = 12.dp, bottom = 18.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp)
    ) {
        // Header + Refresh
        item {
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
                        text = "Homepage",
                        color = HomepageTextPrimary,
                        fontSize = 17.sp,
                        fontWeight = FontWeight.SemiBold
                    )
                    Text(
                        text = "Trending across public trackers, updated daily",
                        color = HomepageTextSecondary,
                        fontSize = 11.5.sp
                    )
                }

                Box(
                    modifier = Modifier
                        .height(32.dp)
                        .clip(RoundedCornerShape(6.dp))
                        .border(1.dp, HomepageBorderStrong, RoundedCornerShape(6.dp))
                        .background(HomepageSurface2)
                        .clickable(enabled = !refreshing) { loadFeed(category, timeWindow, forceRefresh = true) }
                        .padding(horizontal = 11.dp),
                    contentAlignment = Alignment.Center
                ) {
                    Text(
                        text = if (refreshing) "Refreshing…" else "↻ Refresh",
                        color = HomepageTextPrimary,
                        fontSize = 12.sp,
                        fontWeight = FontWeight.Medium,
                        maxLines = 1,
                        softWrap = false
                    )
                }
            }
        }

        // Category + Window Selector Row
        item {
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween
            ) {
                Row(
                    modifier = Modifier
                        .border(1.dp, HomepageBorder, RoundedCornerShape(6.dp))
                        .background(HomepageSurface, RoundedCornerShape(6.dp))
                        .padding(2.dp),
                    horizontalArrangement = Arrangement.spacedBy(2.dp)
                ) {
                    listOf("movies" to "Movies", "tv" to "TV", "anime" to "Anime").forEach { (id, label) ->
                        val active = category == id
                        Box(
                            modifier = Modifier
                                .clip(RoundedCornerShape(4.dp))
                                .background(if (active) HomepageSurface2 else Color.Transparent)
                                .clickable { category = id }
                                .padding(horizontal = 10.dp, vertical = 5.dp)
                        ) {
                            Text(
                                text = label,
                                color = if (active) HomepageTextPrimary else HomepageTextSecondary,
                                fontSize = 11.5.sp,
                                fontWeight = if (active) FontWeight.Medium else FontWeight.Normal,
                                maxLines = 1,
                                softWrap = false
                            )
                        }
                    }
                }

                Row(
                    modifier = Modifier
                        .border(1.dp, HomepageBorder, RoundedCornerShape(6.dp))
                        .background(HomepageSurface, RoundedCornerShape(6.dp))
                        .padding(2.dp),
                    horizontalArrangement = Arrangement.spacedBy(2.dp)
                ) {
                    listOf("1D" to "Day", "7D" to "Week", "30D" to "Month").forEach { (win, label) ->
                        val active = timeWindow == win
                        Box(
                            modifier = Modifier
                                .clip(RoundedCornerShape(4.dp))
                                .background(if (active) HomepageSurface2 else Color.Transparent)
                                .clickable { timeWindow = win }
                                .padding(horizontal = 9.dp, vertical = 5.dp)
                        ) {
                            Text(
                                text = label,
                                color = if (active) HomepageTextPrimary else HomepageTextSecondary,
                                fontSize = 11.5.sp,
                                fontWeight = if (active) FontWeight.Medium else FontWeight.Normal,
                                maxLines = 1,
                                softWrap = false
                            )
                        }
                    }
                }
            }
        }

        // Spotlight Poster Strip
        if (spotlight.isNotEmpty()) {
            item {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.SpaceBetween
                    ) {
                        Text(
                            text = when (category) {
                                "tv" -> "Trending shows"
                                "anime" -> "Trending anime"
                                else -> "Trending movies"
                            },
                            color = HomepageTextPrimary,
                            fontSize = 13.5.sp,
                            fontWeight = FontWeight.SemiBold
                        )
                        Text(
                            text = when (timeWindow) {
                                "1D" -> "Most active right now"
                                "30D" -> "Top releases this month"
                                else -> "This week's popular releases"
                            },
                            color = HomepageTextMuted,
                            fontSize = 11.sp
                        )
                    }

                    LazyRow(
                        horizontalArrangement = Arrangement.spacedBy(10.dp),
                        modifier = Modifier.fillMaxWidth()
                    ) {
                        itemsIndexed(spotlight, key = { idx, card -> "$idx:${card.id}" }) { _, card ->
                            Column(
                                modifier = Modifier
                                    .width(108.dp)
                                    .clip(RoundedCornerShape(6.dp))
                                    .border(1.dp, HomepageBorder, RoundedCornerShape(6.dp))
                                    .background(HomepageSurface)
                                    .clickable { onNavigateToSearch(card.searchQuery) }
                            ) {
                                RemotePosterImage(
                                    url = card.poster,
                                    title = card.title,
                                    modifier = Modifier
                                        .fillMaxWidth()
                                        .height(152.dp)
                                        .clip(RoundedCornerShape(topStart = 6.dp, topEnd = 6.dp))
                                )
                                Column(
                                    modifier = Modifier.padding(horizontal = 7.dp, vertical = 6.dp),
                                    verticalArrangement = Arrangement.spacedBy(2.dp)
                                ) {
                                    Text(
                                        text = card.title,
                                        color = HomepageTextPrimary,
                                        fontSize = 11.5.sp,
                                        fontWeight = FontWeight.Medium,
                                        maxLines = 1,
                                        overflow = TextOverflow.Ellipsis
                                    )
                                    val sub = listOfNotNull(
                                        card.year.takeIf { it.isNotEmpty() },
                                        card.genre.takeIf { it.isNotEmpty() }
                                    ).joinToString(" · ")
                                    if (sub.isNotEmpty()) {
                                        Text(
                                            text = sub,
                                            color = HomepageTextMuted,
                                            fontSize = 10.sp,
                                            maxLines = 1,
                                            overflow = TextOverflow.Ellipsis
                                        )
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }

        // Trending Releases Filter Bar & Count
        if (torrents.isNotEmpty()) {
            item {
                Column(verticalArrangement = Arrangement.spacedBy(7.dp)) {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.SpaceBetween
                    ) {
                        Text(
                            text = "${filteredTorrents.size} trending releases",
                            color = HomepageTextSecondary,
                            fontSize = 11.5.sp,
                            fontFamily = FontFamily.Monospace
                        )
                        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            listOf("trending" to "Top", "seeds" to "Seeds", "size" to "Size").forEach { (key, label) ->
                                val active = sortBy == key
                                Box(
                                    modifier = Modifier
                                        .clip(RoundedCornerShape(5.dp))
                                        .border(1.dp, if (active) HomepageBorderStrong else HomepageBorder, RoundedCornerShape(5.dp))
                                        .background(if (active) HomepageSurface2 else HomepageSurface)
                                        .clickable { sortBy = key }
                                        .padding(horizontal = 8.dp, vertical = 4.dp)
                                ) {
                                    Text(
                                        text = label,
                                        color = if (active) HomepageTextPrimary else HomepageTextSecondary,
                                        fontSize = 11.sp,
                                        fontWeight = if (active) FontWeight.Medium else FontWeight.Normal,
                                        maxLines = 1,
                                        softWrap = false
                                    )
                                }
                            }
                        }
                    }

                    // Quality Pills Row
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .horizontalScroll(rememberScrollState()),
                        horizontalArrangement = Arrangement.spacedBy(5.dp)
                    ) {
                        SearchFilterHelper.QUALITY_FILTERS.forEach { qf ->
                            val count = filterCounts.qualityCounts[qf.id] ?: 0
                            val available = qf.id == "all" || (filterCounts.availableQualities[qf.id] == true)
                            if (available || qualityFilter == qf.id) {
                                val active = qualityFilter == qf.id
                                FilterPillChip(
                                    label = if (qf.id == "all") qf.label else "${qf.label} $count",
                                    active = active,
                                    onClick = { qualityFilter = if (active && qf.id != "all") "all" else qf.id }
                                )
                            }
                        }
                    }

                    // Tag + Source Pills Row
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .horizontalScroll(rememberScrollState()),
                        horizontalArrangement = Arrangement.spacedBy(5.dp),
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        SearchFilterHelper.TAG_FILTERS.forEach { tf ->
                            val count = filterCounts.tagCounts[tf.id] ?: 0
                            val active = tagFilters.contains(tf.id)
                            if (count > 0 || active) {
                                FilterPillChip(
                                    label = "${tf.label} $count",
                                    active = active,
                                    accent = true,
                                    onClick = {
                                        tagFilters = if (active) tagFilters - tf.id else tagFilters + tf.id
                                    }
                                )
                            }
                        }

                        if (sources.size > 1) {
                            FilterPillChip(
                                label = "All sources",
                                active = sourceFilter == "all",
                                onClick = { sourceFilter = "all" }
                            )
                            sources.forEach { src ->
                                val active = sourceFilter == src
                                FilterPillChip(
                                    label = src,
                                    active = active,
                                    onClick = { sourceFilter = if (active) "all" else src }
                                )
                            }
                        }

                        if (hasActiveFilters) {
                            Box(
                                modifier = Modifier
                                    .clip(RoundedCornerShape(4.dp))
                                    .border(1.dp, HomepageAccentBlue.copy(alpha = 0.5f), RoundedCornerShape(4.dp))
                                    .background(HomepageAccentBlue.copy(alpha = 0.12f))
                                    .clickable { resetFilters() }
                                    .padding(horizontal = 8.dp, vertical = 4.dp)
                            ) {
                                Text(
                                    text = "Reset filters",
                                    color = HomepageAccentBlue,
                                    fontSize = 10.5.sp,
                                    fontWeight = FontWeight.Medium,
                                    maxLines = 1,
                                    softWrap = false
                                )
                            }
                        }
                    }
                }
            }
        }

        if (error != null) {
            item {
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .border(1.dp, HomepageDangerRed.copy(alpha = 0.4f), RoundedCornerShape(6.dp))
                        .background(HomepageSurface, RoundedCornerShape(6.dp))
                        .padding(12.dp)
                ) {
                    Text(text = error!!, color = HomepageDangerRed, fontSize = 12.5.sp)
                }
            }
        }

        if (loading && torrents.isEmpty()) {
            item {
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(vertical = 48.dp),
                    contentAlignment = Alignment.Center
                ) {
                    CircularProgressIndicator(
                        color = HomepageAccentBlue,
                        strokeWidth = 2.dp,
                        modifier = Modifier.size(28.dp)
                    )
                }
            }
        } else if (filteredTorrents.isEmpty() && !loading) {
            item {
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .border(1.dp, HomepageBorder, RoundedCornerShape(6.dp))
                        .background(HomepageSurface, RoundedCornerShape(6.dp))
                        .padding(24.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.spacedBy(8.dp)
                ) {
                    Text(
                        text = if (hasActiveFilters) "No releases match your selected filters." else "No trending releases loaded right now.",
                        color = HomepageTextSecondary,
                        fontSize = 13.sp,
                        textAlign = TextAlign.Center
                    )
                    if (hasActiveFilters) {
                        Box(
                            modifier = Modifier
                                .clip(RoundedCornerShape(5.dp))
                                .border(1.dp, HomepageBorderStrong, RoundedCornerShape(5.dp))
                                .background(HomepageSurface2)
                                .clickable { resetFilters() }
                                .padding(horizontal = 12.dp, vertical = 6.dp)
                        ) {
                            Text("Reset filters", color = HomepageTextPrimary, fontSize = 12.sp)
                        }
                    }
                }
            }
        } else {
            itemsIndexed(filteredTorrents, key = { idx, it -> "$idx:${it.provider}:${it.id}:${it.sizeBytes}" }) { _, item ->
                val isDownloaded = remember(item, completedHashes, activeDownloadHashes) {
                    (item.infoHash.isNotEmpty() && activeDownloadHashes.contains(item.infoHash.lowercase())) ||
                        DownloadHistoryManager.isItemDownloaded(item)
                }
                val isResolving = resolvingId == item.id

                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .border(1.dp, HomepageBorder, RoundedCornerShape(6.dp))
                        .background(HomepageSurface, RoundedCornerShape(6.dp))
                        .padding(horizontal = 12.dp, vertical = 10.dp)
                ) {
                    Text(
                        text = item.title,
                        color = HomepageTextPrimary,
                        fontSize = 13.sp,
                        fontWeight = FontWeight.Medium,
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.clickable {
                            onNavigateToSearch(SearchFilterHelper.cleanReleaseSearchQuery(item.title))
                        }
                    )

                    Spacer(modifier = Modifier.height(6.dp))

                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(6.dp)
                    ) {
                        Box(
                            modifier = Modifier
                                .clip(RoundedCornerShape(4.dp))
                                .background(HomepageSurface2)
                                .padding(horizontal = 6.dp, vertical = 2.dp)
                        ) {
                            Text(
                                text = item.provider,
                                color = HomepageTextSecondary,
                                fontSize = 10.sp,
                                maxLines = 1,
                                softWrap = false
                            )
                        }
                        if (item.age.isNotEmpty()) {
                            Text(
                                text = item.age,
                                color = HomepageTextMuted,
                                fontSize = 10.5.sp,
                                maxLines = 1,
                                softWrap = false
                            )
                        }
                        if (isDownloaded) {
                            Row(
                                modifier = Modifier
                                    .clip(RoundedCornerShape(4.dp))
                                    .border(1.dp, HomepageOkGreen.copy(alpha = 0.45f), RoundedCornerShape(4.dp))
                                    .background(HomepageOkGreen.copy(alpha = 0.14f))
                                    .padding(horizontal = 6.dp, vertical = 2.dp),
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.spacedBy(3.dp)
                            ) {
                                Icon(
                                    imageVector = Icons.Default.Check,
                                    contentDescription = null,
                                    tint = HomepageOkGreen,
                                    modifier = Modifier.size(11.dp)
                                )
                                Text(
                                    text = "Downloaded",
                                    color = HomepageOkGreen,
                                    fontSize = 10.sp,
                                    fontWeight = FontWeight.Medium,
                                    maxLines = 1,
                                    softWrap = false
                                )
                            }
                        }
                    }

                    Spacer(modifier = Modifier.height(7.dp))
                    HorizontalDivider(color = HomepageBorder, thickness = 1.dp)
                    Spacer(modifier = Modifier.height(7.dp))

                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.SpaceBetween
                    ) {
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(10.dp),
                            modifier = Modifier
                                .weight(1f)
                                .padding(end = 8.dp)
                        ) {
                            Text(
                                text = item.sizeFormatted,
                                color = HomepageTextSecondary,
                                fontSize = 11.5.sp,
                                fontFamily = FontFamily.Monospace,
                                maxLines = 1,
                                softWrap = false
                            )
                            Text(
                                text = "▲ ${item.seeds}",
                                color = when {
                                    item.seeds >= 50 -> HomepageOkGreen
                                    item.seeds >= 5 -> HomepageTextPrimary
                                    else -> HomepageTextMuted
                                },
                                fontSize = 11.5.sp,
                                fontFamily = FontFamily.Monospace,
                                maxLines = 1,
                                softWrap = false
                            )
                            Text(
                                text = "▼ ${item.leechers}",
                                color = HomepageDangerRed,
                                fontSize = 11.5.sp,
                                fontFamily = FontFamily.Monospace,
                                maxLines = 1,
                                softWrap = false
                            )
                        }

                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(6.dp)
                        ) {
                            Box(
                                modifier = Modifier
                                    .height(28.dp)
                                    .clip(RoundedCornerShape(5.dp))
                                    .border(1.dp, HomepageBorder, RoundedCornerShape(5.dp))
                                    .background(HomepageBgDark)
                                    .clickable {
                                        onNavigateToSearch(SearchFilterHelper.cleanReleaseSearchQuery(item.title))
                                    }
                                    .padding(horizontal = 8.dp),
                                contentAlignment = Alignment.Center
                            ) {
                                Icon(
                                    imageVector = Icons.Outlined.Search,
                                    contentDescription = "Search similar releases",
                                    tint = HomepageTextSecondary,
                                    modifier = Modifier.size(14.dp)
                                )
                            }

                            Box(
                                modifier = Modifier
                                    .height(28.dp)
                                    .clip(RoundedCornerShape(5.dp))
                                    .border(1.dp, HomepageBorderStrong, RoundedCornerShape(5.dp))
                                    .background(HomepageSurface2)
                                    .clickable(enabled = resolvingId == null) { handleDownload(item) }
                                    .padding(horizontal = 11.dp),
                                contentAlignment = Alignment.Center
                            ) {
                                Text(
                                    text = when {
                                        isResolving -> "Resolving…"
                                        isDownloaded -> "Download again"
                                        else -> "↓ Download"
                                    },
                                    color = HomepageTextPrimary,
                                    fontSize = 11.5.sp,
                                    fontWeight = FontWeight.Medium,
                                    maxLines = 1,
                                    softWrap = false
                                )
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
fun FilterPillChip(
    label: String,
    active: Boolean,
    accent: Boolean = false,
    onClick: () -> Unit
) {
    val borderColor = when {
        active && accent -> HomepageAccentBlue.copy(alpha = 0.7f)
        active -> HomepageBorderStrong
        else -> HomepageBorder
    }
    val bgColor = when {
        active && accent -> HomepageAccentBlue.copy(alpha = 0.16f)
        active -> HomepageSurface2
        else -> HomepageSurface
    }
    val textColor = when {
        active && accent -> HomepageAccentBlue
        active -> HomepageTextPrimary
        else -> HomepageTextSecondary
    }
    Box(
        modifier = Modifier
            .clip(RoundedCornerShape(5.dp))
            .border(1.dp, borderColor, RoundedCornerShape(5.dp))
            .background(bgColor)
            .clickable(onClick = onClick)
            .padding(horizontal = 9.dp, vertical = 4.dp)
    ) {
        Text(
            text = label,
            color = textColor,
            fontSize = 11.sp,
            fontWeight = if (active) FontWeight.Medium else FontWeight.Normal,
            maxLines = 1,
            softWrap = false
        )
    }
}
