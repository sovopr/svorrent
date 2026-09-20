# Svorrent

A minimalist, high-speed torrent discovery engine and 1-click launch platform.

## Features

- **Multi-Tracker Aggregation**: Concurrently queries top public indexers (The Pirate Bay, LimeTorrents, TorrentProject) with normalized metadata (seeds, peers, size).
- **1-Click Native Client Launch**: Resolves magnet URIs dynamically and opens your configured desktop/web client (Transmission, qBittorrent, BitTorrent Web) without broken tab redirects.
- **Direct Magnet Clipboard Copy**: Fast copy with visual confirmation.
- **Proxy Streaming Engine**: Built-in backend proxy using WebTorrent to download and stream files directly via standard HTTP.
- **Minimalist Aesthetic**: Clean, dark-mode, non-cluttered interface with instant search.

## Project Structure

```
svorrent/
├── backend/          # Node.js + Express + WebTorrent + TorrentSearchApi
│   ├── server.js     # API endpoints (/api/search, /api/magnet, /api/stream)
│   └── package.json
└── frontend/         # React + Vite
    ├── src/
    │   ├── App.jsx   # Search interface and 1-click action buttons
    │   └── index.css # Minimalist dark-mode design system
    └── package.json
```

## Getting Started

### 1. Backend

```bash
cd backend
npm install
node server.js
```

Runs on `http://localhost:3001`.

### 2. Frontend

```bash
cd frontend
npm install
npm run dev
```

Runs on `http://localhost:5173`.

## License

MIT
