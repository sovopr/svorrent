# Svorrent for Android

Native Android Torrent engine written in **Kotlin + Jetpack Compose** powered by **`libtorrent4j` (`2.1.0-31`)** with simultaneous **Wi-Fi + 5G/LTE Mobile Data Bonding**.

## Key Features
- **Simultaneous Wi-Fi + Cellular Bonding (`MultiNetworkBondingManager.kt`):** Holds both `TRANSPORT_WIFI` and `TRANSPORT_CELLULAR` active via `ConnectivityManager.requestNetwork()` and binds `libtorrent` across both interfaces (`listen_interfaces` + `outgoing_interfaces`).
- **Swarm Pipeline Accelerator (`SvorrentEngine.kt`):** 200 max connections, 1500 request queue, rolling 16-piece critical frontier for instant sequential video playback, and Android `ForegroundService` background execution with smart idle notification dismissal.
- **Progressive Streaming Search (`SearchRepository.kt`):** Progressive coroutine streaming, dual Cloudflare `1.1.1.1` and Google `8.8.8.8` DNS-over-HTTPS (DoH) with Happy-Eyeballs socket racing, and intelligent movie-first relevance scoring.
- **Rolling Main & Release Updates (`AutoUpdater.kt`):** Detects both tagged releases and rolling `main-latest` GitHub Actions builds without version bumps, verifying SHA-256 integrity and prompting only when an update is available.
- **Automated CI Builds (`.github/workflows/`):** Pushes to `main` compile signed `Svorrent.apk` rolling builds via `android-main.yml`, and official releases publish alongside desktop packages with SHA-256 integrity verification.

