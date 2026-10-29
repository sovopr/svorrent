# Security Policy

Svorrent takes the security and privacy of its users seriously. As a peer-to-peer Torrent engine with local API orchestration and multi-network bonding, Svorrent incorporates built-in defense-in-depth measures.

---

## Supported Versions

Only the latest release branch actively receives security patches:

| Version | Supported |
| :---    | :---      |
| `1.0.x` | Yes       |
| `< 1.0` | No        |

We strongly encourage all users to run the latest version or update using the built-in in-app updater.

---

## Architecture & Security Model

Svorrent incorporates multiple proactive security layers:

1. **Host Loopback Origin Firewall (`local-access.js`)**:
   - The backend binds strictly to loopback interfaces (`127.0.0.1`, `::1`).
   - All incoming API requests require strict `Host` and `Origin` header validation against loopback origins to prevent DNS rebinding attacks and cross-origin unauthorized script execution.
2. **Path Traversal Containment (`safe-path.js`)**:
   - All file operations enforce strict directory sandboxing within designated user folders (`~/Downloads/Svorrent/` and application cache).
   - Relative path traversals (`../`) and illegal character sequences are rejected.
3. **Anti-Censorship DNS-over-HTTPS (`doh.js`)**:
   - Tracker domain resolution employs encrypted DNS-over-HTTPS (DoH) fallbacks to resist local network DNS tampering and censorship.
4. **Verified Code Integration & Checksums**:
   - Official releases are distributed with `SHA256SUMS.txt` cryptographic digests.
   - The desktop silent updater cryptographically validates downloaded releases and runs self-tests (`node --check` and unit test suites) before prompting integration.

---

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

If you believe you have discovered a vulnerability in Svorrent, submit a report privately through GitHub Security Advisories:

1. Navigate to the [Security Advisories](https://github.com/sovopr/svorrent/security/advisories) tab on GitHub.
2. Click **"Report a vulnerability"** to submit your advisory directly to the repository maintainer.
3. This opens a secure, private advisory workspace where maintainers can review, discuss, and coordinate a patch before public disclosure.

### What to Include in Your Report
To help us triage and resolve the issue quickly, please provide:
- A description of the vulnerability and its potential impact.
- Clear, reproducible steps or a minimal proof-of-concept (PoC).
- Your environment details (OS, version of Svorrent, Node.js version, browser).
- Any proposed mitigations or fixes, if known.

### Response Timeline
- **Initial Acknowledgement**: Within 48 hours of receipt.
- **Triage & Assessment**: Within 5 business days.
- **Remediation & Advisory**: We will work with you to develop and verify a fix, and coordinate public disclosure once a patched release is published.

Thank you for responsibly disclosing security issues and helping keep Svorrent users safe.
