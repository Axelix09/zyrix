# Security policy and threat model

Zyrix is a WhatsApp Web protocol implementation, not a hosted service. The security of a
deployment depends on the account, the host and the code that uses the library. This
document states what Zyrix does, what it does not do, and how to report a problem.

## Status

- Zyrix is beta software. The API can change between minors while the audit findings are
  still being closed.
- **No independent cryptographic review has been performed.** The Signal, Noise and
  media-crypto code is covered by regression tests and cross-implementation fixtures, but
  tests are not a substitute for a review by a cryptographer.
- The repository's own real-world smoke test has **not** been executed against WhatsApp at
  the time of this writing. See [REAL-WORLD-TESTING.md](REAL-WORLD-TESTING.md).

## Reporting a vulnerability

Open a private security advisory in the GitHub repository
(`Security` → `Report a vulnerability`). Do not open a public issue with exploit details.
Include the affected version, a minimal reproducer, and whether the issue needs a real
WhatsApp account. You will get an acknowledgement and, when the report is valid, a fix and
credit unless you ask otherwise.

## Threat model

### In scope

| Asset | Protection |
| --- | --- |
| Session credentials at rest | Optional AES-256-GCM snapshot with PBKDF2-derived key, authenticated header, atomic writes and a validated backup. Without a key the snapshot is JSON, not encrypted. |
| Signal sessions | XEdDSA/X25519, double ratchet, per-device sessions serialized by address, skipped-message keys capped per chain. |
| Sender keys | Distribution, replay/duplicate rejection, rotation on removal. |
| Device identity changes | Visible through `identity.changed` and `state.keys.identityHistory`; `trustPolicy` decides whether to accept. |
| Media | Size limits, authenticated encryption, `O_NOFOLLOW` for local files, SSRF/DNS-rebinding protection for remote URLs, header stripping on cross-origin redirects. |
| Parsing | Bounded protobuf/binary decoding, frame-size limits, malformed input rejected with stable `errorCode`s. |
| Session files | Atomic write + rename, restrictive permissions, size limits, concurrent-writer detection. |
| App state | Version/LTHash checks; a rejected patch leaves the state byte-for-byte unchanged. |

### Out of scope

- WhatsApp's servers, account bans, and compliance with WhatsApp's Terms of Service. Using
  an unofficial client can get an account restricted or banned. That risk belongs to the
  operator, not to the library licence.
- A compromised host, a malicious dependency, or a stolen session file whose encryption key
  is stored next to it.
- Endpoint compromise: if the phone or the server running Zyrix is compromised, message
  contents and keys are available to the attacker.
- An adversary who can modify the library at build time.

### Residual risks you must decide on

1. **Man-in-the-middle on identity change.** `trustPolicy: 'update'` is the default for
   compatibility: a contact who reinstalls WhatsApp must keep working. It audits and logs
   the change but accepts it. For sensitive bots use `'tofu'` or a function that checks the
   owner. No policy proves who owns a new key.
2. **Unverified interoperability.** The protocol code can drift from WhatsApp's current
   client. Only a real-account smoke test detects that.
3. **Media in memory.** Some paths buffer complete files (documented in the README); size
   limits bound the damage, they do not eliminate memory pressure.
4. **Third-party URLs.** SSRF protections reject private destinations, but a bot that
   fetches arbitrary user URLs should still run with egress restrictions.
5. **Plugin hot reload.** Development-only. Every reload keeps the previous ES module in
   memory; do not enable it in production.

## Cryptographic review checklist

A reviewer should at minimum verify:

- XEdDSA signing/verification and X25519 agreement against the Signal specification.
- The double-ratchet state machine: root/chain key derivation, message-key skipping limits,
  out-of-order handling, and that a failed MAC never mutates state.
- Prekey bundle parsing: identity trust, one-time prekey consumption, and that a forged
  prekey message cannot pin or replace a contact identity.
- Sender-key distribution/encryption and rotation on membership changes.
- Media key expansion (HKDF info strings per media type), CBC+HMAC construction, MAC
  comparison in constant time, and the 10-byte truncation.
- Noise handshake transcript, prologue and payload encoding.
- Session snapshot format: KDF parameters, IV uniqueness, authenticated associated data,
  backup semantics and key rotation.
- The default `trustPolicy` and every path that mutates `identityHistory`.

## Supported versions

Security fixes target the latest published minor. Older minors may receive a fix at the
maintainer's discretion; upgrade before reporting if you can.

## Dependency and supply-chain policy

Runtime dependencies are kept deliberately small and pinned by the lockfile. `npm audit
--omit=dev` is expected to report zero vulnerabilities on `main`. New dependencies require
a written justification in the pull request, including why the code cannot live in the
repository. See [CONTRIBUTING.md](CONTRIBUTING.md).
