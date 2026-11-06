# Svorrent for Android

Native Android Torrent engine written in **Kotlin + Jetpack Compose** powered by **`libtorrent4j` (`2.1.0-31`)** with simultaneous **Wi-Fi + 5G/LTE Mobile Data Bonding**.

## Key Features
- **Simultaneous Wi-Fi + Cellular Bonding (`MultiNetworkBondingManager.kt`):** Holds both `TRANSPORT_WIFI` (`wlan0`) and `TRANSPORT_CELLULAR` (`rmnet_data*`) active via `ConnectivityManager.requestNetwork()` and binds `libtorrent` across both interfaces (`listen_interfaces` + `outgoing_interfaces`).
- **Swarm Pipeline Accelerator (`SvorrentEngine.kt`):** 200 max connections, 1500 request queue, rolling 16-piece critical frontier for instant sequential video playback, and Android `ForegroundService` background execution.
- **Anti-Censorship Search (`SearchRepository.kt`):** Automatic Cloudflare `1.1.1.1` DNS-over-HTTPS (DoH) fallback to bypass carrier/ISP blocks.
- **Automated Monorepo Builds (`.github/workflows/release.yml`):** Every release compiles and signs `Svorrent.apk` alongside macOS and Windows desktop packages with SHA-256 integrity verification.

