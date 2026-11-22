# Licensing

Starting with **0.19.0**, Zyrix is distributed under the **MIT License**. The full text is in [`LICENSE`](./LICENSE). Versions up to and including 0.18.0 were released under `GPL-3.0-only` and remain available under that licence.

Nothing here is legal advice; if your organisation needs a firm answer, have your own counsel read it.

## Why it was GPL, and what changed

Up to 0.18.0 the end-to-end encryption layer relied on the `libsignal` npm package (6.0.0), which is licensed GPL-3.0. A program distributed together with GPL-3.0 code must itself be distributable under GPL-3.0, so Zyrix was honestly GPL.

In 0.19.0 that dependency was removed. The Signal pieces Zyrix needs are now implemented in this repository:

- `src/crypto.js`: X25519 key generation and agreement on Node's native `crypto`, and XEdDSA-style Curve25519 signatures on top of [`@noble/curves`](https://github.com/paulmillr/noble-curves) (MIT).
- `src/signal.js`: X3DH key agreement, the Double Ratchet, prekey and whisper message construction and the wire format, written from the public Signal specifications ([X3DH](https://signal.org/docs/specifications/x3dh/), [Double Ratchet](https://signal.org/docs/specifications/doubleratchet/), [XEdDSA](https://signal.org/docs/specifications/xeddsa/)).
- `src/senderkey.js` (group sender keys) and `src/pb.js` (minimal protobuf codec) were already in-house.

No GPL or other copyleft package remains in the dependency tree (the runtime dependency tree contains only MIT, Apache-2.0 and BSD-3-Clause packages). The repository has a single author, who holds the copyright on all of Zyrix's own code and can therefore relicense it.

## How the new implementation was checked

Criteria recorded in this document before the change, and where they stand:

1. **In-house implementation, no copyleft dependency.** Done (see above).
2. **Interoperability.** The new implementation was run against the previous libsignal-based one, in both directions and mixing both implementations on the same stored sessions: 105 conversations and about 6,400 messages with ratchet steps, out-of-order, delayed and duplicate delivery, and sessions re-established while old messages were still in flight. Session records, messages and signatures produced by the previous implementation are kept as fixtures (`tests/fixtures/libsignal-sessions.json`), so the suite keeps checking that existing sessions continue to work without needing `libsignal`. **Pending:** repeating the [real WhatsApp checklist](./README.md#real-whatsapp-validation) on a test account before publishing 0.19.0 to npm.
3. **Known failure modes of a hand-written ratchet.** Covered by tests: message keys are used once (duplicates rejected), skipped keys are bounded (2,000 per chain, 5 receiving chains, 40 archived sessions), the session is only updated after the MAC checks out, and a tampered message leaves the stored state untouched. An external cryptographic review has not been done.
4. **No new copyleft dependency.** `@noble/curves` is MIT.

## What this means if you use Zyrix

- From 0.19.0 you can use, modify and distribute Zyrix in open or closed-source products under the MIT terms: keep the copyright and licence notice.
- Third-party components keep their own licences (MIT, Apache-2.0 and BSD-3-Clause); see [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md) and `THIRD_PARTY_LICENSES/`.
