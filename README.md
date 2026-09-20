# Svorrent

A minimalist, high-speed torrent discovery engine and 1-click launch platform.

## Features

- **Multi-Tracker Aggregation**: Concurrently queries top public indexers (The Pirate Bay, LimeTorrents, TorrentProject) with normalized metadata (seeds, peers, size).
- **100% Lossless Remux Browser Streaming (`/player`)**: Dedicated cinema theater tab that transmuxes raw 4K UHD Blu-ray Remuxes (MKV, TrueHD, DTS-HD MA) on-the-fly into fragmented MP4 using `-c:v copy` without any re-encoding loss.
- **Dedicated Downloads Manager (`/downloads`)**: Standalone downloads dashboard with filter tabs (All, Downloading, Completed, Paused, Live Streams), global bandwidth HUD, real choking pause/resume, and 1-click Finder/Explorer reveal.
- **Deep Wire Packet & Piece Map Nerd Inspector**: Real-time modal inspecting connected peers, country flags, client handshakes (uTorrent, qBittorrent, Transmission), piece bitfield radar, and DHT/tracker states.
- **Native Desktop Player Passthrough**: 1-click launch directly into desktop players (IINA, VLC, MPC-HC) with zero external app dependencies for BitTorrent downloading.
- **Cross-Platform Architecture**: Hardware-accelerated fallbacks for macOS (Apple Silicon VideoToolbox) and Windows (NVENC / ultrafast libx264).
- **Zero-Clutter Search UI**: Search window is fast, minimal, and uncluttered with quick 1-click download and streaming actions.

## Project Structure

```
svorrent/
├── backend/                  # Node.js + Express + WebTorrent + FFmpeg transmuxer
│   ├── server.js             # API endpoints (/api/search, /api/torrents, /api/stream/remux)
│   └── package.json
└── frontend/                 # React + Vite
    ├── src/
    │   ├── App.jsx           # Search interface and top navigation
    │   ├── CinemaPlayer.jsx  # Dedicated theater mode tab (/player)
    │   ├── DownloadsManager.jsx # Dedicated downloads tab (/downloads)
    │   ├── NerdModal.jsx     # Deep wire packet & piece bitfield inspector
    │   └── index.css         # Dark-mode design system
    └── package.json
```

## Getting Started

### 1. Backend

```bash
cd backend
npm install
node server.js
```

Runs on `http://localhost:3001`. Native downloads save to `~/Downloads/Svorrent/`.

### 2. Frontend

```bash
cd frontend
npm install
npm run dev
```

Runs on `http://localhost:5173`.

## License

MIT

