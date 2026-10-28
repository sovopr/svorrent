# Contributing to Svorrent

Thank you for your interest in contributing to Svorrent! Whether you are reporting a bug, proposing new features, improving documentation, or submitting pull requests, your contributions are welcome.

Please take a moment to review this document to ensure a smooth collaboration.

---

## Code of Conduct

By participating in this project, you agree to abide by the [Code of Conduct](CODE_OF_CONDUCT.md). Please report any unacceptable behavior to the maintainers.

---

## How Can I Contribute?

### 1. Reporting Bugs
- Check the [existing issues](https://github.com/sovopr/svorrent/issues) before opening a new one to avoid duplicates.
- Use the **[Bug report](.github/ISSUE_TEMPLATE/bug_report.md)** template.
- Include clear reproduction steps, environment details (OS, version, browser, active network adapters), and relevant logs from `~/Library/Logs/Svorrent/svorrent.log` (macOS) or the console.

### 2. Suggesting Features
- Open an issue using the **[Feature request](.github/ISSUE_TEMPLATE/feature_request.md)** template.
- Describe the proposed feature, the problem it solves, and any alternatives you have considered.

### 3. Improving Documentation
- Corrections to `README.md`, setup guides, code comments, or architectural documentation are always appreciated.

### 4. Contributing Code
- Start by discussing larger changes in an issue before writing code.
- Follow the development workflow outlined below.

---

## Development Setup

### Prerequisites
- **Node.js**: `22.12.0` or newer (`node -v`)
- **npm**: `10.x` or newer
- **Git**
- Optional: **VLC media player** (for local streaming playback testing)
- Optional: **ffmpeg** / **ffprobe** (for real-media integration tests)

### Getting the Code
```bash
git clone https://github.com/sovopr/svorrent.git
cd svorrent
```

### Running the Backend
```bash
cd backend
npm ci
npm start
```
The backend API server runs on `http://localhost:3001`. Downloads default to `~/Downloads/Svorrent/`.

### Running the Frontend
```bash
cd frontend
npm ci
npm run dev
```
The Vite development server runs on `http://localhost:5173`.

---

## Testing & Quality Assurance

Svorrent runs a comprehensive test suite across platforms. Ensure all tests pass before opening a pull request.

### Backend Tests
```bash
cd backend
npm test                # Unit test suite
npm run test:e2e        # Loopback synthetic torrent integration test (requires ffmpeg)
```

### Frontend Tests & Linting
```bash
cd frontend
npm run lint            # Oxlint static code analysis
npm test                # Frontend unit tests
npx playwright test     # Isolated UI end-to-end tests (Chromium & WebKit)
```

### Packaging Builds Locally
```bash
# macOS DMG build (outputs to dist-app/Svorrent.dmg)
cd backend && npm run build:dmg

# Windows NSIS installer & portable ZIP (outputs to dist-win/)
cd backend && npm run build:win
```

---

## Pull Request Guidelines

1. **Branch Naming**: Use descriptive branch names:
   - `fix/issue-description`
   - `feat/feature-name`
   - `docs/clarification`
2. **Commit Style**: Use clear, concise commit messages following the [Conventional Commits](https://www.conventionalcommits.org/) format (e.g. `feat: add piece availability graph`, `fix: prevent loopback timeout`).
3. **Keep PRs Focused**: Avoid bundling unrelated changes into a single pull request.
4. **Pass All Status Checks**: All PRs must pass deterministic multi-platform CI checks before being merged.
5. **Fill out the Pull Request Template**: Provide context on what changed and how you tested it.

---

## Project Structure Overview

```
svorrent/
├── backend/            # Express REST API, WebTorrent orchestration, network bonding
│   ├── lib/            # Networks, torrent engine, updater, playability, safe paths
│   └── test/           # Backend unit and integration test suites
├── frontend/           # React 19 single-page application (Vite)
│   ├── src/            # Search, Downloads, Networks, Swarm modals, Icons
│   └── test/           # Frontend unit and Playwright E2E suites
├── scripts/            # Native macOS Cocoa and Windows launchers, DMG/NSIS packaging
└── docs/               # Architecture diagrams and security documentation
```

Thank you for contributing to Svorrent!
