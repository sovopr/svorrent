# Svorrent for Android

Native Kotlin + Jetpack Compose + `libtorrent4j` torrent client featuring full desktop parity: a curated **Homepage** trending explorer, federated multi-indexer **Search** with quality/tag filters, persistent **Download History**, manual file deletion reconciliation, simultaneous **Wi-Fi + Cellular (5G/LTE)** bonding, sequential streaming, and SHA-256 verified in-app APK updates.

## Key Features

- **Homepage & Trending Discovery (`HomepageScreen.kt`, `DiscoverRepository.kt`)**:
  - Dedicated **Homepage** tab (and tapping the top **svorrent** brand mark) displays trending **Movies**, **TV**, and **Anime** across **Day (`1D`)**, **Week (`7D`)**, and **Month (`30D`)** timeframes.
  - Interactive spotlight poster carousel powered by IMDb suggestions, Apple iTunes RSS, and AniList GraphQL with strict HTTPS CDN validation (`isAllowedPosterUrl`) and LRU memory caching. Tapping any poster card immediately searches all indexers for that title.
  - Multi-source consensus ranking across `extto.org`, Knaben, The Pirate Bay, EZTV, and Nyaa with deduplication, adult/CAM penalties, timeframe decay filtering, and deferred magnet resolution (`resolveMagnet`).
- **Federated Search & Inline Filters (`SearchRepository.kt`, `SearchFilterHelper`)**:
  - Streams live results from The Pirate Bay, BitSearch, Knaben, Torrents.csv, and Nyaa over Cloudflare/Google DNS-over-HTTPS (DoH) fallback.
  - Inline filter chips for resolution (`All`, `4K`, `1080p`, `720p`, `SD`), release tags (`Remux`, `BluRay`, `WEB-DL`, `HDR`, `Dolby Vision`, `HEVC`), source filter pills, relative age badges, and **Reset filters**.
- **Persistent Download History (`DownloadHistoryManager.kt`)**:
  - Records completed downloads locally (`download-history.json`) by info hash and normalized title/size across restarts and deletions, displaying a **Downloaded** badge and **Download again** action across both **Homepage** and **Search**.
- **Manual File Deletion Reconciliation (`ReconcileHelper.kt`, `SvorrentEngine.kt`)**:
  - Detects when downloaded files are deleted externally via Android Files / OEM file managers, immediately releases native `libtorrent4j` file handles and storage space, removes the stale transfer so it does not automatically re-download, cleans leftover empty directories, and guards against unmounted storage roots or unstarted metadata-pending magnets.
- **Multi-Network Bonding & Sequential Streaming (`MultiNetworkBondingManager.kt`, `SvorrentEngineService.kt`)**:
  - Requests simultaneous Wi-Fi and 5G/LTE mobile data sockets via Android `ConnectivityManager` and runs persistently in a background foreground service.
  - Prioritizes sequential pieces for external player streaming (`MX Player`, `VLC`, etc.) and supports SHA-256 verified in-app APK updates (`AutoUpdater.kt`).

## Module Layout

- `android/app/src/main/java/com/svorrent/app/MainActivity.kt` — Navigation tabs (`Homepage`, `Search`, `Downloads`, `Networks`), Search filter UI, Downloads controls, and update modal.
- `android/app/src/main/java/com/svorrent/app/HomepageScreen.kt` — Curated trending UI, poster carousel, timeframe/category controls, and release table.
- `android/app/src/main/java/com/svorrent/app/DiscoverRepository.kt` — Multi-source trending scrapers, poster artwork resolution, scoring, and 10-minute stale-while-revalidate cache.
- `android/app/src/main/java/com/svorrent/app/SearchRepository.kt` — Federated search providers (including Knaben), deferred magnet resolution, and DoH HTTP stack.
- `android/app/src/main/java/com/svorrent/app/DownloadHistoryManager.kt` — Atomic JSON store (`minSdk 26` compatible) and `StateFlow` badge state.
- `android/app/src/main/java/com/svorrent/app/ReconcileHelper.kt` — Disk presence verification, traversal containment, and safe directory cleanup.
- `android/app/src/main/java/com/svorrent/app/SvorrentEngine.kt` — `libtorrent4j` session lifecycle, piece priority frontier, and runtime deletion reconciliation.
- `android/app/src/main/java/com/svorrent/app/AutoUpdater.kt` — GitHub release / rolling CI APK check, streaming SHA-256 verification, and PackageInstaller launcher.
- `android/app/src/main/java/com/svorrent/app/Models.kt` — Data classes, relative age formatters, and `SearchFilterHelper`.

## Building & Running Tests

From the `android/` directory (requires Android SDK 34+ & JDK 17):

```bash
cd android
./gradlew testReleaseUnitTest assembleRelease
```

The APK artifact is produced under `android/app/build/outputs/apk/release/`. Unit tests (`SearchSanitizerTest.kt` and `SvorrentFeaturesTest.kt`) run automatically in GitHub Actions CI (`ubuntu-latest`) on every push and pull request.
