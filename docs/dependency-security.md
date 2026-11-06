# Dependency security

CI runs a production-dependency audit on both npm lockfiles and uploads the JSON reports.

In v1.0.8, the legacy `torrent-search-api` / `request` scraper package was completely removed and replaced by native zero-dependency scrapers. This eliminated 22 inherited advisories (including all critical CVEs). The frontend has 0 advisories.

The 4 remaining backend advisories are confined to the upstream `ip` package dependency inherited through WebTorrent's tracker client stack (`bittorrent-tracker` -> `torrent-discovery` -> `webtorrent`). Do not use `npm audit fix --force`: npm proposes an incompatible tracker downgrade that would break torrent discovery behavior.

Dependabot opens weekly pull requests for backend, frontend, and GitHub Actions dependency updates. Review the attached audit report after each change and keep the loopback torrent, browser-download, and media-decoding tests green.
