# Zyrix

**English** · [Español](./README.es.md)

Zyrix is a Node.js library for WhatsApp bots and automation. It implements the WhatsApp Web multi-device protocol directly over a WebSocket — no browser, no Selenium, no Chromium, no page automation. A complete bot should fit in a few lines, a throwing handler must not take down your process, and the API should answer to your own names, in whatever language you prefer.

WhatsApp Web's protocol changes without notice, and Zyrix is not affiliated with WhatsApp or Meta. The author has tested Zyrix manually against a real WhatsApp account; the automated suite does not connect to the service and does not cover every account or feature, so protocol changes still need re-validation. Use it only with accounts and devices you own or are authorised to use.

## Why Zyrix

- **Sessions are encrypted at rest.** AES-256-GCM with a scrypt-derived key, atomic writes, `0600` permissions, a backup copy and symlink rejection. Opt-in, and documented as such: the key lives outside the session folder.
- **The connection lifecycle is solved, not delegated.** The launcher handles relaunches, session resets, a deleted session folder, pairing codes and OS signals, and reports every failure as an event you can act on.
- **A bot runtime ships with it.** Commands, middleware, cooldowns, permissions and hot-reloaded plugins live in `@axel-dev09/zyrix/kit`, so the core stays protocol-only and your bot does not need a framework on top.
- **Failures are typed.** `ZyrixError` carries `kind`, `code` and `retryable`; sends wait for the server ack and say `unconfirmed` instead of pretending; undeliverable devices are reported through `send.warning`.
- **The gaps are written down.** [What it still doesn't do](#what-it-still-doesnt-do) and [Roadmap](#roadmap) list the missing pieces, so you can decide with the whole picture.

## Contents

- [Installation](#installation)
- [Quick start](#quick-start)
- [Building a bot with the command kit](#building-a-bot-with-the-command-kit)
- [Receiving messages and events](#receiving-messages-and-events)
- [Sending messages](#sending-messages)
- [JID, PN and LID](#jid-pn-and-lid)
- [Groups, profile, privacy and more](#groups-profile-privacy-and-more)
- [Sessions and store](#sessions-and-store)
- [Connection and reconnection](#connection-and-reconnection)
- [Errors](#errors)
- [Security](#security)
- [Business, channels and communities](#business-channels-and-communities)
- [Using it from other languages](#using-it-from-other-languages)
- [What it still doesn't do](#what-it-still-doesnt-do)
- [How Zyrix compares to Baileys](#how-zyrix-compares-to-baileys)
- [Roadmap](#roadmap)
- [Real WhatsApp validation](#real-whatsapp-validation)
- [Development, licence and notices](#development-licence-and-notices)

## Installation

You need Node.js 18.17 or newer. The package is ESM (`"type": "module"`), so it is imported with `import`, not `require`.

```bash
npm install @axel-dev09/zyrix
```

You can also install it straight from GitHub:

```bash
npm install github:Axelix09/zyrix
```

All exports are named:

```js
import { start, connect, makeSocket, useFileAuthState, createStore, parseMessage, DisconnectReason, content, jidDecode } from '@axel-dev09/zyrix'
```

Zyrix does not ship a finished bot. Your process imports the module, sets up authentication, registers listeners and calls what it needs. TypeScript declarations are in `index.d.ts`.

## Quick start

`start` does what almost everyone ends up writing by hand around a connection: it opens the session, requests the pairing code (or shows a QR if you do not pass a number), reconnects, pairs again when the session stops being valid and shuts down cleanly. It prints nothing of its own. It emits events and you decide what to show.

```js
import { start } from '@axel-dev09/zyrix'

const launcher = await start({ session: './session', phoneNumber: '5215551234567' })
launcher.sock.sendText('5215551234567@s.whatsapp.net', 'hi')
```

Without `phoneNumber` it shows a QR. You can also pass a function (plain or `async`) that is called only when pairing is needed, for example `promptPhone('Number: ')`. `await start()` resolves when the socket opens. If it fails before that, it rejects with a `ZyrixError` of kind `closed`.

The socket changes when pairing has to happen again, so anything that depends on it belongs in `setup`. If `setup` returns a function, it runs when that socket is retired:

```js
import { start } from '@axel-dev09/zyrix'
import { createBot } from '@axel-dev09/zyrix/kit'

await start({
  session: './session',
  phoneNumber: '5215551234567',
  signals: true,
  setup: (sock) => {
    const bot = createBot(sock, { prefix: '!' })
    bot.command('ping', (m) => m.reply('pong'))
    return () => bot.stop()
  },
  on: {
    'pairing-code': (code, formatted) => console.log(formatted),
    fatal: ({ reason }) => console.error(reason)
  }
})
```

If you need to listen for events before starting, `createLauncher(options)` gives you the launcher without starting it, and you start it with `launcher.start()`.

### Launcher events

`socket`, `open`, `qr`, `pairing-code` (`code`, `formatted`), `status`, `issue`, `fatal`, `signal` and `stopped`.

`status` carries `{ state }`, which can be `connecting` (with `registered` and `phoneNumber`), `pairing`, `open`, `reconnecting` (with `reason`, `name` and `restart`) or `relaunching` (with `why`: `logged-out`, `bad-session`, `multidevice-mismatch`, `corrupt-session` or `session-deleted`).

`issue` reports problems that do not kill the connection. Its `type` can be `sender-key-miss` (batched every 10 s with a `count`), `stream-error`, `connection-rejected`, `idle`, `timeout`, `save-error`, `setup-error`, `cleanup-error`, `session-deleted` or `error`.

`fatal` means the connection cannot recover on its own. `reason` is the name of a `DisconnectReason` (`connectionReplaced`, `forbidden`, `clientOutdated`...) or one of `too-many-relaunches`, `invalid-phone`, `auth-error`, `connect-error` or `launch-error`. The process never exits by itself.

### Launcher options

| Option | What it does |
| --- | --- |
| `autoReset` (`true`) | If WhatsApp logs the session out, rejects it or leaves it corrupt, it deletes the local session and pairs again. With `false` it only emits `fatal`. |
| `maxRelaunches`, `relaunchWindowMs` | Relaunch cap. Defaults to 4 in 10 minutes. |
| `relaunchDelayMs` | Wait between relaunches. |
| `watchSession`, `watchIntervalMs` | Detect that someone deleted the session folder. |
| `signals` | `true` or a list. Shuts down cleanly on SIGINT, SIGTERM, SIGHUP and SIGTSTP and calls `process.exit`, unless you set `exit: false`. |
| `printCode` | If nobody listens for `pairing-code`, prints the code formatted as `XXXX-XXXX`. |
| `connector` | Your own function to create the socket. |

Everything else is passed to the socket. If you use a session adapter, automatic reset needs a `clear()` method on it. Without one, the launcher emits `fatal`.

`launcher.stop()` closes without unlinking the device. `launcher.logout()` unlinks it and deletes the session. There are standalone helpers too: `parsePhoneNumber`, `formatPairingCode`, `promptPhone` and `reasonName`.

To encrypt the file session automatically, pass an external secret to the process (do not hard-code it and do not store it next to the session):

```js
await start({ session: './session', sessionEncryptionKey: process.env.ZYRIX_SESSION_KEY })
```

Generate a random value of at least 16 bytes and keep it in a secret manager. When an old session is migrated, Zyrix rewrites it encrypted.

### Without the launcher

If you would rather manage the connection yourself:

```js
import { connect } from '@axel-dev09/zyrix'

const sock = await connect({ session: './session', phoneNumber: '5215551234567' })
```

`session` can be a path or a [session adapter](#sessions-and-store). `makeSocket(options)` is the lowest-level entry point and receives an already-built `auth`.

## Building a bot with the command kit

The kit is optional and imported separately (`@axel-dev09/zyrix/kit`) so the core stays clean. If a handler throws, the kit catches it and the process keeps running.

```js
import { connect } from '@axel-dev09/zyrix'
import { createBot } from '@axel-dev09/zyrix/kit'

const sock = await connect({ session: './session', phoneNumber: '5215551234567' })
const bot = createBot(sock, { prefix: ['!', '.'], owners: ['5215551234567'], cooldown: 3 })

bot.command(['ping', 'p'], (m) => m.reply('pong'), { description: 'latency', category: 'utility' })
bot.command('kick', async (m) => sock.groups.kick(m.chat, m.mentions), { admin: true, botAdmin: true, group: true })
bot.command('register', async (m) => {
  const answer = await m.ask('What is your name?')
  await m.reply(answer ? `Done, ${answer.text}` : 'Time is up')
})

await bot.loadPlugins('./plugins', { watch: true })
```

### Commands, hears and middleware

`bot.command(names, handler, meta)` accepts `description`, `category`, `usage`, `group`, `private`, `admin`, `botAdmin`, `owner`, `hidden` and `cooldown` (in seconds) in `meta`. To react to text without a prefix use `bot.hears(pattern, handler)`, and for middleware `bot.use((m, next) => ...)`. `bot.help()` and `bot.menu()` build the menu in whatever format you want; what `bot.list()` and `bot.menu()` return always uses the internal names.

The kit imposes no prefixes. Without `prefix` it only serves `hears` and `use`, and registering a command throws a `ZyrixError` of kind `invalid`. With `prefix: ''` commands are called with no prefix. When you catch kit errors, look at `kind`, not at the message text.

### Denial and error messages

The kit sends no text of its own. If you do not define the replies, it answers nothing. Define them in `createBot(sock, { messages })` with these keys: `groupOnly`, `privateOnly`, `ownerOnly`, `adminOnly`, `botAdmin`, `cooldown` and `error`. Each can be a string or a function. If you prefer your own logic, listen for `command.denied` and `command.error`.

### Plugins

`bot.loadPlugins(dir, { watch, recursive })` loads the `.js` and `.mjs` files in a folder (skipping those that start with `_`) and reloads them when you save. A plugin can export an object `{ commands, run, ...meta }`, an array of such objects, or a function `(bot) => {}`. In the last case you can call `bot.onUnload(fn)` to clean up what you created.

Note: if you change a module that a plugin imports, it does not reload on its own. Only the plugin file is reloaded.

### Your own vocabulary

You do not have to use the English names. With the `vocabulary` (or `vocabulario`) option of `createBot` you tell Zyrix what you call each thing. Every map goes from your name to the internal name, and anything you do not map keeps working with the original name.

| Map | What it renames |
| --- | --- |
| `options` | `createBot` options |
| `command` | command metadata and keys |
| `messages` | denial texts (also the `reason` of `command.denied`) |
| `hears` | `hears` keys |
| `plugin` | `setup`, `teardown`, `commands` and `hears` |
| `context` | what the handler receives as its second argument |

```js
import { createBot, vocabularioEs } from '@axel-dev09/zyrix/kit'

const bot = createBot(sock, { prefijo: '!', vocabulario: vocabularioEs, mensajes: { soloAdmin: 'Admins only.' } })
bot.command('kick', async (m) => sock.groups.kick(m.chat, m.mentions), { soloAdmin: true, soloGrupo: true, botAdmin: true })

const custom = createBot(sock, { vocabulary: { options: { pref: 'prefix' }, command: { requires: 'admin' }, messages: { requires: 'adminOnly' } }, pref: '#' })
```

`vocabularioEs` is a Spanish preset: `soloAdmin`, `soloGrupo`, `soloPrivado`, `soloDueno`, `oculto`, `descripcion`, `categoria`, `uso`, `ejecutar`, `nombres`, `espera`, `prefijo`, `mensajes`, `patron`, `comandos`, `escuchar`, `preparar`, `limpiar`, `texto`, `argumentos`, among others. Copy and change it, or build one from scratch.

### Bot events

`command`, `command.error`, `command.denied`, `command.unknown`, `plugin.loaded`, `plugin.unloaded` and `plugin.error`.

## Receiving messages and events

### The message with context

`sock.on('message', (m) => ...)` hands you a `MessageContext`: everything `parseMessage` returns plus several ready-made actions.

- Actions: `reply`, `say`, `react`, `unreact`, `delete`, `edit`, `forward`, `read`, `download`, `typing`, `group`, `isAdmin`, `isBotAdmin`, `getQuoted` and `ask`.
- Properties: `number`, `isMentioned` and `hasMedia`.

The `messages.upsert` event is still emitted as well, if you prefer it.

Edits, deletions, reactions and poll votes do not arrive as `message`. They have their own events: `message.edit`, `message.revoke`, `message.reaction` and `poll.vote`. The vote arrives undecrypted, in `raw`.

### Conversations

`sock.waitForMessage(filter, timeout)` and `m.ask(text, { timeout, filter, strict })` wait for a reply. If nobody answers they return `null`, or throw a `ZyrixError` of kind `timeout` if you pass `strict: true`.

### Errors inside listeners

The socket uses `captureRejections`. If an `async` listener throws, the error reaches the `error` event and never becomes an `unhandledRejection`.

### parseMessage

`parseMessage(event)` (also available as `socket.parseMessage`) turns a `messages.upsert` into an object such as `{ chat, sender, senderAlt, isGroup, type, text, mentions, quoted, media, offline, ... }`. The `quoted` value can be passed straight to `reply`.

### Every socket event

`open`, `close`, `qr`, `pairing-code`, `connection.update`, `messages.upsert`, `receipt`, `contacts.upsert`, `chats.update`, `app-state.mutation`, `groups.update`, `group-participants.update` (`add`, `remove`, `promote`, `demote`, `leave`), `presence.update`, `call`, `identity.changed`, `send.warning` and `error`.

`connection.update` folds connection state into `{ connection: 'connecting' | 'open' | 'close', qr, isNewLogin, lastDisconnect }`. Messages arriving from the offline queue carry `offline: true`, which lets you ignore stale commands after reconnecting.

### Coming from Baileys

Aliases exist so the migration is mechanical: `sock.ev` is the emitter itself (`sock.ev.on(...)` does the same as `sock.on(...)`), `sock.user` is `auth.state.creds.me` and `sock.authState` is the connection's authentication state.

## Sending messages

### Methods

| For | Methods |
| --- | --- |
| Text | `sendMessage(jid, content, options?)`, `sendText(jid, text, options?)` |
| Quoted replies | `reply(to, text, quoted)` |
| Buttons, lists and polls | `sendButtons`, `sendInteractive`, `sendList`, `sendPoll` |
| Other formats | `sendReaction`, `sendLocation`, `sendContact`, `sendContacts`, `sendMedia` |
| Media shortcuts | `sendImage`, `sendVideo`, `sendAudio`, `sendDocument`, `sendSticker` |
| Deleting and editing | `sendDelete(jid, target)`, `sendEdit(jid, target, text)` |
| Forwarding and invites | `forward(jid, message)`, `sendGroupInvite` |
| Albums and sticker packs | `sendAlbum(jid, items)`, `sendStickerPack(jid, { pack, name, publisher, stickers })` |

The common options are `quoted` (an event with `key` and `message`), `mentions` and `contextInfo`. There is also `expiration` (disappearing messages), `viewOnce` (image, video or audio) and `linkPreview`. Images, videos and documents accept a `caption`.

If the group uses disappearing messages and you do not pass `expiration`, Zyrix uses the group's duration. That requires the group metadata to be cached.

### Content shapes

`sendMessage` looks at the shape of the content and routes it to the right method. It understands `{ image, caption }`, `{ video, caption }`, `{ audio, ptt }`, `{ document, fileName }`, `{ sticker }`, `{ buttons, text }`, `{ list }`, `{ poll }`, `{ location }`, `{ contact }`, `{ contacts }`, `{ delete: key }` and `{ edit: key, text }`. It also accepts complete protobuf objects.

### Send confirmation

`sendMessage` and the other `send*` methods wait for the server ack and return `{ key, message, status, messageTimestamp }`. `status` is `'sent'`, or `'unconfirmed'` if 30 seconds pass without an ack. If the server rejects the message, an error with a `code` is thrown. If it cannot be encrypted for any of the recipient's devices, an error is thrown instead of sending silently, and the devices that were skipped are reported through `send.warning`.

### Media

The types are `image`, `video`, `audio`, `document` and `sticker`. You can pass a Buffer, a `Uint8Array`, a path, a URL, `{ url }`, `{ path }` or `{ stream }`. Buffers and URLs are still bound by `maxMediaBytes` (100 MiB by default). For large files, `{ stream }` is written in chunks to a private temporary file and then encrypted and uploaded through the file path; the limit is `maxFileBytes` (2 GiB by default) and you need free disk space (a send may need close to twice the file size, for the source and encrypted temporaries). `thumbnail`, `width`, `height`, `seconds` and `waveform` are also accepted. For small attachments, `downloadMedia(message)` returns a Buffer. To download a large attachment without loading it into memory, use `downloadMediaToFile(message, outputPath, { maxBytes, timeout })`: it decrypts in chunks and only publishes the final file if the MAC is valid. It never overwrites an existing output file.

`sendAlbum` uploads each image or video and associates them with `MessageAssociation.MEDIA_ALBUM`. It returns the messages and the image and video counts. The protocol does not guarantee every WhatsApp version shows them as a single card.

A sticker pack is built with `content.stickerPack(...)`. The `pack` file must contain the pack, and each `stickers` entry needs its `fileName`, the emojis and, optionally, metadata. Packs you receive are downloaded with `downloadMedia`.

### Content builders

They build a message without sending it: `content.text`, `buttons`, `interactive`, `list`, `poll`, `location`, `contact`, `reaction`, `vcard({ name, number })` and `buildMessage`. To read received messages there are `content.extractText` and `content.unwrapMessage`.

Buttons, lists and interactive messages depend on what the service and the account type allow. Check that they work for your case before relying on them.

## JID, PN and LID

WhatsApp has two kinds of identifiers: the phone-based one (`123@s.whatsapp.net`, PN) and an opaque one (`9001@lid`, LID). In groups the `participant` sometimes arrives as a LID. When the server also sends the phone number, Zyrix stores both:

```js
const meta = await socket.groupMetadata(groupJid)
const participant = await socket.getGroupParticipant(groupJid, '9001@lid')

participant.id          // canonical identifier, usually the LID
participant.lid         // 9001@lid
participant.phoneNumber // 123@s.whatsapp.net, if WhatsApp provided it
participant.username    // received notify/name, if any
```

Message events carry `participantAlt` and `remoteJidAlt` when Zyrix already knows the PN/LID pair. In commands, do not compare strings by hand: use `resolveJid`, `getJidAliases` and `isGroupAdmin`. A LID is never forced into a phone number. The phone number only appears when WhatsApp provided the equivalence. `onWhatsApp(...numbers)` checks numbers and, on the way, learns PN/LID pairs.

Exported JID helpers: `jidDecode`, `jidEncode`, `normalizeJid`, `jidNormalizedUser`, `jidWithoutDevice`, `jidType`, `isJidUser`, `isJidLid`, `isJidPN` and `isJidGroup`.

## Groups, profile, privacy and more

`sock.groups`, `sock.privacy`, `sock.profile`, `sock.chats` and `sock.presence` group methods by topic and, where it makes sense, accept one or several users. The flat methods (`groupParticipantsUpdate`, `updatePrivacyCategory`, and so on) still exist.

```js
await sock.groups.add(jid, '5215551234567@s.whatsapp.net')
await sock.groups.onlyAdminsTalk(jid)
await sock.privacy.lastSeen('contacts')
await sock.chats.pin(jid)
sock.presence.typing(jid)
```

### Reference

| Area | Methods |
| --- | --- |
| Groups | `groupCreate`, `groupMetadata`, `groupFetchAllParticipating`, `getGroupParticipant`, `getGroupAdmins`, `isGroupAdmin`, `groupParticipantsUpdate`, `groupUpdateSubject`, `groupUpdateDescription`, `groupSettingUpdate`, `groupLeave`, `groupInviteCode`, `groupRevokeInvite`, `groupAcceptInvite`, `groupGetInviteInfo`, `groupRequestParticipantsList`, `groupRequestParticipantsUpdate`, `groupToggleEphemeral`, `groupMemberAddMode`, `groupJoinApprovalMode` |
| Own account | `updateProfileName`, `updateProfileStatus`, `updateProfilePicture`, `removeProfilePicture`, `profilePictureUrl`, `fetchStatus`, `getBusinessProfile`, `fetchBlocklist`, `updateBlockStatus` |
| Privacy | `fetchPrivacySettings`, `updateLastSeenPrivacy`, `updateOnlinePrivacy`, `updateProfilePicturePrivacy`, `updateStatusPrivacy`, `updateReadReceiptsPrivacy`, `updateGroupsAddPrivacy`, `updateMessagesPrivacy`, `updateCallPrivacy`, `updateDefaultDisappearingMode` |
| Receipts and presence | `readMessages(keys)`, `sendReceipt`, `sendPresenceUpdate('available' \| 'unavailable' \| 'composing' \| 'recording' \| 'paused', jid?)`, `presenceSubscribe` |
| Chats and calls | `chatModify({ pin \| mute \| archive \| markRead }, jid)`, `rejectCall` (or the `autoRejectCalls` option) |
| Session | `requestPairingCode`, `syncAppState`, `waitForOpen`, `logout`, `end` (returns a promise that waits for the session to be saved) |

`fetchStatus` only reads a user's text status. All of this depends on what the account and the server allow at any given moment.

Changing the profile name uses the `appStatePatch` generator, with LTHash, index MAC, value MAC, `snapshotMac` and `patchMac`, and stores state per collection. If no app-state key has arrived yet, it falls back to the profile IQ.

## Sessions and store

### File session

`useFileAuthState(dir, { debounceMs, encryptionKey })` keeps the keys in a single file, `state.json`, with atomic writes, `0600` permissions and a `state.json.bak` copy. `encryptionKey` enables authenticated AES-256-GCM encryption with a scrypt-derived key. Keep it outside the folder and outside Mongo (a secret manager, for example); if you lose it you cannot recover the session. Without that option, older unencrypted JSON snapshots remain compatible. Saves are asynchronous and batched according to `debounceMs` (300 by default). `auth.flush()` waits for them and rejects if the state could not be persisted; the socket also reports the failure through the `error` event. If `creds.json` and `keys.json` from older versions are present, they are read and migrated into the snapshot.

The library fixes permissions on POSIX systems and rejects symlinks for the session folder and files. Keep the folder private, out of a repository, and never share it. Optional encryption protects the files and backups at rest, but it does not replace access control on the process or the secret.

### Adapters

`useAdapterAuthState(adapter, { encryptionKey })` accepts any object with `{ read(), write(data) }` and encrypts the snapshot if you pass a key. `start`, `createLauncher` and `connect` accept `sessionEncryptionKey` to use the same encryption when they create the session automatically. `memoryAdapter()` and `mongoAdapter(collection, id)` are included; the latter works with the official MongoDB driver. For several sessions, use a different `id` per account (`mongoAdapter(collection, 'bot-a')`, `mongoAdapter(collection, 'bot-b')`); each one ends up in its own document and the adapter enforces a safe limit below the 16 MB BSON cap. A corrupt session throws instead of creating a new one and losing your pairing.

One limitation is worth keeping in mind: the adapter writes the whole state every time, batched by `debounceMs`, and does not yet write per key. That includes credentials, Signal sessions, sender keys and app-state keys, and it grows with the number of contacts and groups. With `mongoAdapter` the document cannot exceed MongoDB's 16 MB. If you run several sessions in one process, or accounts with heavy activity, use one document per session (the `id` of `mongoAdapter(collection, id)`), raise `debounceMs` and watch the size of `state.json`.

### Store

`createStore(socket, { maxMessagesPerChat, maxChats })` keeps messages, chats, contacts, groups and presence with memory limits. It can be dumped to disk with `writeToFile` and read with `readFromFile`.

`makeInMemoryStore(options)` is another option, with the same shape as the socket store. You bind it with `store.bind(sock)` and it provides `loadMessage`, `getMessage`, `getMessages`, `toJSON`, `fromJSON`, `writeToFile` and `readFromFile`.

So that retry receipts can be answered even after the process restarts, hand the store to the socket:

```js
const sock = await makeSocket({ auth, getMessage: (key) => store.getMessage(key) })
```

## Connection and reconnection

The `close` event reports `{ reason, loggedOut, reconnecting }`. Some reasons are terminal and never retried: `401` (logged out), `403`, `405`, `411`, `440` (replaced by another session) and `500` (damaged session). Everything else reconnects with exponential backoff and jitter, except `515` (restart after pairing), which reconnects immediately.

Keepalive closes and restarts the connection after two failed pings or 80 seconds without data. The options that adjust all of this are `reconnect`, `maxReconnectAttempts`, `keepAliveIntervalMs` and `queryTimeoutMs`.

`end()` can be called more than once and stops automatic reconnection. If the socket detects a Noise decryption error or a protocol parsing error, it closes and schedules a reconnect.

## Errors

Zyrix errors are `ZyrixError`. They carry a `kind` (`timeout`, `closed`, `not-ready`, `rejected`, `invalid`, `no-session`, `decrypt`, `media` or `auth`), a `code` when the server sends one, and `retryable`. `ErrorKind` and `isZyrixError` are exported.

```js
try {
  await sock.sendText(jid, 'hi')
} catch (error) {
  if (isZyrixError(error, ErrorKind.REJECTED)) console.log(error.code)
  else if (error.retryable) retry()
}
```

## Security

### Socket options

Besides the connection ones, `makeSocket` accepts:

| Option | Description |
| --- | --- |
| `browser` | `[system, browser, version]`. Defaults to `['Mac OS', 'Chrome', '4.0.0']`. Used to build the `UserAgent`, the `webInfo` and the registration `DeviceProps`. |
| `maxMediaBytes` | Limit for media handled in memory. 100 MiB by default. |
| `maxFileBytes` | Limit for media going to disk or a stream. 2 GiB by default; needs enough temporary space. |
| `logger` | Your own logger. |
| `getMessage` | Retrieves messages to answer retry receipts. |
| `autoRejectCalls` | Rejects calls automatically. |
| `markOnlineOnConnect` | With `false`, the phone keeps receiving notifications. |
| `syncFullHistory` | `false` by default. |
| `minSendIntervalMs` | Minimum interval between sends. |
| `trustPolicy` | What to do when a device identity changes (see below). |
| `sentCacheSize`, `groupCacheSize` | Cache sizes. |

```js
const socket = await makeSocket({ auth, browser: ['Mac OS', 'Chrome', '4.0.0'], maxMediaBytes: 25 * 1024 * 1024 })
```

### trustPolicy

Controls what happens when a Signal device you already knew shows up with a new identity.

- `'update'` (default) accepts the new identity, replaces it and emits `identity.changed`. It is what a bot needs when a contact reinstalls WhatsApp.
- `'tofu'` rejects the change, and decryption fails until you delete that device's session.
- A function `(id, newIdentity, storedIdentity) => boolean` lets you decide case by case.

Every identity change, accepted or rejected, emits `identity.changed` with `{ id, accepted }`. The `id` is the device's Signal identifier (`user.device`). It is worth listening to. An identity change is normal when someone reinstalls WhatsApp, but it is also what you would see behind a man in the middle.

```js
sock.on('identity.changed', ({ id, accepted }) => {
  console.log(`identity of ${id} changed, accepted: ${accepted}`)
})

const sock = await makeSocket({
  auth,
  trustPolicy: async (id, newIdentity, storedIdentity) => owners.has(id.split('.')[0])
})
```

If your bot only serves known contacts or handles sensitive information, use `'tofu'` or a function that decides per user. With `'update'` you accept any new key without intervention.

### Other protections

HTTP(S) URLs passed as media are validated to reject loopback, private/link-local networks, local hosts, non-standard ports and redirects to non-public destinations. Even so, avoid passing arbitrary user-controlled URLs to an internet-exposed bot, and apply egress rules on the server: your network and DNS controls are the final defence against malicious DNS changes. Media operations use size limits; remote downloads have a configurable timeout.

Incoming messages that were already processed are dropped by id for 10 minutes, so a server redelivery does not cause errors or retries. When someone is removed from a group, the group's own sender key is rotated. Device-change notifications invalidate the device cache, and `encrypt` notifications top up prekeys.

## Business, channels and communities

### Business

For accounts with those capabilities, the socket includes `getCatalog({ jid?, limit?, cursor? })`, `getCollections(jid?, limit?)`, `getOrderDetails(orderId, tokenBase64)`, `productCreate(product)`, `productUpdate(productId, update)`, `productDelete(productIds)`, `updateBusinessProfile(profile)`, `updateCoverPhoto(image)` and `removeCoverPhoto(id)`.

The same methods, with shorter names, are on `sock.business`: `catalog`, `collections`, `orderDetails`, `createProduct`, `updateProduct`, `deleteProducts`, `profile`, `coverPhoto`, `removeCoverPhoto` and `getProfile`.

To create a product pass `name`, `description`, `price`, `currency` and `images`. Images accept the same inputs as `MediaInput` and are uploaded to WhatsApp's catalog path.

```js
await sock.business.createProduct({ name: 'Mug', description: 'Ceramic', price: 12.5, currency: 'USD', images: ['./mug.jpg'] })
```

Whether it works depends on the account and on the server protocol, so test it with a test account first. This uses the WhatsApp Web linked-device protocol. It is not the WhatsApp Business Platform or the Cloud API.

### Channels and communities

`sock.newsletters` has `create`, `metadata`, `follow`, `unfollow`, `mute` and `unmute`. `sock.communities` has `create`, `linkGroups`, `unlinkGroup` and `subgroups`. These are WhatsApp Web features and depend on the account and server allowing the operation.

## Using it from other languages

Zyrix runs on Node.js and is written in JavaScript, with TypeScript declarations for your editor and static checking. Python, Go, Rust and other languages cannot import it directly. If your bot is in another language, write a client in that language or run Zyrix on Node behind a service with a network API. That bridge is not part of this package.

If you build the bridge, protect it with access control and never expose the session keys to the remote client.

## What it still doesn't do

- **Publishing statuses.** There is no method to publish text or media to `status@broadcast`.
- **Poll votes.** `poll.vote` delivers the raw payload. Zyrix does not decrypt it or map it to the poll options.
- **Migrating PN to LID sessions.** Known PN/LID aliases are kept, but Signal cryptographic sessions are not migrated from one identifier to another.
- **Expired media.** `downloadMedia` fails if the link has expired. It does not request a fresh upload or retry through the linked phone.
- **End-to-end streaming.** Sending from `{ stream }` and `downloadMediaToFile` already avoid loading the whole file into memory, but they use local temporaries; there is no API that connects the network stream directly to encryption or decryption.
- **Per-key saving.** Adapters still write the whole snapshot on every save. That is usually enough; if a heavily used session approaches the BSON limit, this persistence is worth redesigning.
- **Per-chat send parallelism.** Sends are still serialised globally to protect shared Signal sessions and keep ordering. It was not converted to per-chat queues: that needs concurrency tests with overlapping sessions first.

## How Zyrix compares to Baileys

Public information as of November 2026; check each project's docs for the current state. The rows where Zyrix loses are listed on purpose — a comparison you cannot trust is not worth reading.

| | Zyrix | Baileys |
| --- | --- | --- |
| Licence | GPL-3.0-only, because of `libsignal` | MIT |
| Language | JavaScript with hand-written `.d.ts` | TypeScript, declarations built from source |
| Session at rest | Encrypted AES-256-GCM + scrypt, atomic write, `0600`, backup, symlink rejection | JSON files; encryption is left to the integrator |
| Session backends | File, memory, MongoDB, any `{ read, write }`, one document per account | `useMultiFileAuthState` plus community adapters |
| Connection lifecycle | Built-in launcher: relaunch, reset, deleted-session watcher, signals, pairing code | Assembled by the integrator |
| Bot runtime | `@axel-dev09/zyrix/kit`: commands, middleware, plugins with hot reload, vocabulary | Not included |
| Errors | `ZyrixError` with `kind`, `code`, `retryable` | Boom errors |
| Protocol coverage | No status publishing, raw poll votes, no PN→LID session migration | Status posts, channels and communities |
| Scale in one process | Whole snapshot per save, sends serialised globally | Key-by-key auth store, `p-queue`, hundreds of sessions reported in production |
| Validation | 17 unit tests plus a manual checklist on a real account | Jest suite, e2e harness, ~11.6k stars and a large deployment base |

Read it the honest way: if what you need is the widest protocol surface or a permissive licence today, Baileys is the safer choice. If what you need is a session that is encrypted at rest by default, a connection that recovers on its own and a bot runtime with no framework on top, that is the gap Zyrix fills.

## Roadmap

Where the project is going, not a promise with dates. The order is deliberate, because each item unblocks the next.

1. **A permissive licence.** Replace `libsignal` with an in-house Signal implementation so the package can move to MIT or Apache-2.0. Today the GPL dependency is the single biggest obstacle to adoption in commercial and closed-source projects.
2. **Multi-session scale.** Per-key persistence and per-chat send queues, so one process can host many accounts the way production WhatsApp services need.
3. **Public proof.** A scheduled end-to-end run against a throwaway account, with the results published: sessions, messages, reconnections, decrypt failures.
4. **Protocol coverage.** Status publishing, poll vote decryption, PN→LID session migration and re-requesting expired media.
5. **Tooling.** Declarations generated from source with a drift check in CI, so the types cannot fall behind the code.
6. **Distribution.** A docs site, English-first documentation (done) and a migration guide for teams coming from other clients.

## Real WhatsApp validation

Zyrix has been tested manually against real WhatsApp. The automated suite does not repeat those operations; this checklist is for extending the test or repeating it when the protocol or the connection layer changes. Use a test account (not your main one):

- Pair by QR and by code, restart the process and confirm the session recovers without pairing again.
- Message new contacts and contacts who reinstall WhatsApp (`identity.changed`).
- Try large groups: send, receive, add and remove participants, and confirm the sender key rotates.
- Send and receive every media type, and try edits, deletions and reactions.
- Cut the network, kill the process and leave the bot offline for a while, to see reconnection, the offline queue and retry receipts behave.
- Watch for repeated decrypt errors and undelivered messages (`status: 'unconfirmed'`).

## Development, licence and notices

Run `npm install`, then `npm test` and `npm run typecheck`. The CI matrix covers Node 18, 20 and 22.

Zyrix is distributed under the GNU GPL v3 (`GPL-3.0-only`). The full text is in [`LICENSE`](./LICENSE). It is GPL because it depends on `libsignal`, which is GPL-3.0: any program that distributes Zyrix together with that dependency must be distributable under a GPL-3.0-compatible licence.

If you only use Zyrix to run your own bot on your server, without distributing the program to other people, you do not have to publish your code. This is general guidance, not legal advice. If you need another licence, the path is replacing `libsignal` with a Signal implementation whose licence works for you.

Third-party attributions and licences are in [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md).
