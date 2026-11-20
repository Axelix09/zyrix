# Licensing

Zyrix is distributed under the **GNU General Public License v3.0 only** (`GPL-3.0-only`). The full text is in [`LICENSE`](./LICENSE).

This document records why, what was considered before settling on it, and what would have to change to move the package to a permissive licence. Nothing here is legal advice; if your organisation needs a firm answer, have your own counsel read it.

## Why GPL-3.0-only

Zyrix implements the WhatsApp Web protocol, and the end-to-end encryption layer relies on `libsignal` 6.0.0. That package is licensed **GPL-3.0** and is the only mature JavaScript implementation of the Signal protocol in use: it is installed roughly 900,000 times a week and is the same dependency every other WhatsApp Web library builds on.

GPL-3.0 is copyleft. A program that is distributed together with GPL-3.0 code must itself be distributable under GPL-3.0. Since `libsignal` sits on the message path of every Zyrix connection, the honest licence for this package is GPL-3.0, and that is what `package.json` and `LICENSE` declare.

## Options that were evaluated and rejected

**Swapping in another library.** There is no permissive replacement today. `@ecync/libsignal`, the closest drop-in in API surface, is itself GPL-3.0 and has negligible adoption; the official `signalapp/libsignal` is AGPL-3.0, which is stricter. Moving between GPL implementations would churn security-critical code without removing the constraint.

**Dual licensing (GPL plus a commercial licence).** Zyrix's own code is authored here and could be dual licensed, but the GPL portions belong to their authors. A commercial licence could not grant rights over `libsignal`, so the combined program would still be bound by GPL-3.0. Selling an exception before the dependency is gone would be misleading, so it is not offered.

**Calling the package MIT and leaving the GPL dependency to the user.** This is the pattern used elsewhere in the ecosystem, and it does not hold up. The dependency stays on the runtime path, so a closed-source distribution still carries GPL-3.0 code; audits and security reviews flag exactly this, which is why the largest library in this space has publicly committed to migrating away from `libsignal` for licensing reasons.

## Decision

**For 0.18.0 the package stays `GPL-3.0-only`.** The licence reflects the code as it is, and the README comparison table says so openly rather than hiding it.

**The single unlock is removing `libsignal`.** A permissive licence becomes possible only when the Signal implementation is written in-house, which is a first-class roadmap item rather than a metadata change. It is not done yet, and it will not be claimed until it works.

## What a relicense would require

The licence only changes when all of these are true:

1. X3DH key agreement, the Double Ratchet, prekey message construction and the wire format are implemented in this repository, with no GPL-3.0 dependency anywhere in the tree.
2. Interoperability is proven against real WhatsApp peers: a session established, messages exchanged in both directions, prekey messages consumed, and ratchet state advancing correctly across restarts.
3. The cryptography is reviewed for the known failure modes of a hand-written ratchet: key reuse, out-of-order message handling, replay, and skipped-message keys.
4. No new copyleft dependency replaces the old one.

Until point 2 is satisfied, a relicense would be a promise the code cannot keep.

## What this means if you use Zyrix

- **Running your own bot on your own server.** GPL-3.0 obligations attach to distribution. If you do not hand the program to anyone else, you are not obliged to publish your own code.
- **Shipping Zyrix inside a distributed product.** The product as distributed must comply with GPL-3.0, which in practice means releasing the corresponding source under a GPL-3.0-compatible licence. If that is unacceptable, Zyrix is the wrong choice today, and the honest recommendation is to wait for the `libsignal` removal or use a stack with the licence you need.

Third-party attributions and licence texts are in [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md) and `THIRD_PARTY_LICENSES/`.
