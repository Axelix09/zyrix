# Real-world testing (manual, real WhatsApp account)

Everything in `tests/` runs offline with fixtures and mocked transports. That proves the
code does what the tests say; it does **not** prove that WhatsApp's current servers accept
it. This document is the missing evidence. The table below is intentionally empty: these
checks have **not** been executed by the repository.

Use a disposable account and a disposable device. Never use a primary number.

## Prerequisites

- Node >= 20.19 and a clean clone (`npm ci`).
- A phone with WhatsApp and a number you can lose.
- A session directory outside the repository, for example `/tmp/zyrix-smoke`.
- A second account (or a group with a trusted contact) to exercise inbound events.

## Harness

`scripts/smoke-real.mjs` connects, waits for `open`, sends one text message to the account
itself and exits. It refuses to run unless you opt in:

```bash
ZYRIX_SMOKE=1 \
ZYRIX_SMOKE_SESSION=/tmp/zyrix-smoke \
ZYRIX_SMOKE_PHONE=5491100000000 \
node scripts/smoke-real.mjs
```

`ZYRIX_SMOKE_PHONE` is optional: without it the launcher prints a QR code. The script is a
harness, not a test suite; a successful run only proves connect + self-send + server ack.
Everything else is manual.

## Checklist

Record date, Zyrix version, Node version, phone model and WhatsApp version for each run.
Mark `PASS`, `FAIL` or `PENDIENTE`; a failure needs the `errorCode`, the step and relevant
logs with secrets removed.

| # | Check | How | Result |
| --- | --- | --- | --- |
| 1 | Pairing by QR | Fresh session, scan from the phone, reach `open` | PENDIENTE |
| 2 | Pairing by code | Fresh session with `phoneNumber`, enter the 8-digit code | PENDIENTE |
| 3 | Session persistence | Restart the process with the same session directory, no new pairing | PENDIENTE |
| 4 | Encrypted session | Repeat 3 with `sessionEncryptionKey`; a wrong key must fail | PENDIENTE |
| 5 | Self-send and server ack | `sendMessage(me.id, '...')` with `waitAck: true` | PENDIENTE |
| 6 | Inbound text | Second account sends a message; `messages.upsert` and receipt | PENDIENTE |
| 7 | Reply, mention, reaction, edit, delete | Exercise each builder against the second account | PENDIENTE |
| 8 | Media upload | Image, document and voice note (`ptt`) arrive and play | PENDIENTE |
| 9 | Media download | `downloadMedia` and `downloadMediaToFile` on received media | PENDIENTE |
| 10 | Group send/receive | Group text, participant add/remove, sender-key distribution | PENDIENTE |
| 11 | Group metadata and invite | `groupMetadata`, `groupInviteCode`, join from the phone | PENDIENTE |
| 12 | Receipts and read state | Delivery/read receipts, `readMessages` | PENDIENTE |
| 13 | Retry/decryption path | Force a missing session (new device) and verify retry recovery | PENDIENTE |
| 14 | Reconnect | Kill the network, restore it, reconnect without losing the session | PENDIENTE |
| 15 | Offline queue | Receive messages while offline; they arrive with `offline: true` | PENDIENTE |
| 16 | Buttons/list/native flow | Send, tap, and verify `extractInteractiveId` | PENDIENTE |
| 17 | Polls and votes | Create a poll, vote from the phone, receive `poll.vote` | PENDIENTE |
| 18 | `ask()` | Reply within the timeout; also test the timeout path | PENDIENTE |
| 19 | Identity change | Reinstall WhatsApp on the second account; audit `identity.changed` | PENDIENTE |
| 20 | Communities and channels | Create/follow/metadata if the account has the capability | PENDIENTE |
| 21 | App-state patch | Pin/mute/archive from Zyrix and verify on the phone | PENDIENTE |
| 22 | Long run | 24-72 h with keep-alive, memory and reconnect stability | PENDIENTE |

## Reporting results

Add the completed table (with secrets removed) to the release notes or a GitHub issue.
Until then, documentation must describe Zyrix as beta and **not** claim production readiness
or verified interoperability. If a check fails, open an issue with the step number; do not
mark the release stable because the offline suite is green.
