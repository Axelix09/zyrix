# Zyrix

Zyrix es una biblioteca de Node.js para hacer bots y automatizaciones sobre WhatsApp Web. La hizo Axelix09 desde cero, con Baileys como referencia pero sin copiarlo. La idea es que un bot completo se escriba con pocas líneas, que un error en tus handlers no tire el proceso y que puedas usar la API con tus propios nombres, en español si quieres.

El protocolo de WhatsApp Web cambia sin avisar y Zyrix no tiene relación con WhatsApp ni con Meta. Las pruebas locales no aseguran que el emparejamiento o la entrega funcionen en una cuenta real (más abajo, en [Validación con WhatsApp real](#validación-con-whatsapp-real), hay una lista de cosas para probar). Úsalo solo con cuentas y dispositivos que sean tuyos o que tengas autorizados.

## Contenido

- [Instalación](#instalación)
- [Inicio rápido](#inicio-rápido)
- [Hacer un bot con el kit de comandos](#hacer-un-bot-con-el-kit-de-comandos)
- [Recibir mensajes y eventos](#recibir-mensajes-y-eventos)
- [Enviar mensajes](#enviar-mensajes)
- [JID, PN y LID](#jid-pn-y-lid)
- [Grupos, perfil, privacidad y más](#grupos-perfil-privacidad-y-más)
- [Sesiones y store](#sesiones-y-store)
- [Conexión y reconexión](#conexión-y-reconexión)
- [Errores](#errores)
- [Seguridad](#seguridad)
- [Business, canales y comunidades](#business-canales-y-comunidades)
- [Usarlo desde otros lenguajes](#usarlo-desde-otros-lenguajes)
- [Lo que todavía no hace](#lo-que-todavía-no-hace)
- [Validación con WhatsApp real](#validación-con-whatsapp-real)
- [Desarrollo, licencia y avisos](#desarrollo-licencia-y-avisos)

## Instalación

Necesitas Node.js 18.17 o más nuevo. El paquete es ESM (`"type": "module"`), así que se importa con `import`, no con `require`.

```bash
npm install zyrix
```

Si todavía no lo instalas desde npm, puedes usar la carpeta en local. En el `package.json` de tu bot:

```json
{ "dependencies": { "zyrix": "file:./zyrix" } }
```

Todos los exports son nombrados:

```js
import { start, connect, makeSocket, useFileAuthState, createStore, parseMessage, DisconnectReason, content, jidDecode } from 'zyrix'
```

Zyrix no trae un bot hecho. Tu proceso importa el módulo, configura la autenticación, registra los listeners y llama a lo que necesite. Los tipos de TypeScript están en `index.d.ts`.

## Inicio rápido

`start` hace lo que casi todos acaban escribiendo a mano alrededor de la conexión: abre la sesión, pide el código de emparejamiento (o muestra el QR si no le das un número), reconecta, vuelve a emparejar cuando la sesión deja de servir y cierra bien al terminar. No imprime textos propios. Solo emite eventos y tú decides qué mostrar.

```js
import { start } from 'zyrix'

const launcher = await start({ session: './session', phoneNumber: '5215551234567' })
launcher.sock.sendText('5215551234567@s.whatsapp.net', 'hola')
```

Sin `phoneNumber` muestra el QR, igual que Baileys. También puedes pasar una función (normal o `async`) que se llama solo cuando hace falta vincular, por ejemplo `promptPhone('Número: ')`. `await start()` termina cuando el socket abre. Si falla antes, rechaza con un `ZyrixError` de tipo `closed`.

El socket cambia cuando hay que volver a emparejar, así que la lógica que dependa de él va en `setup`. Si `setup` devuelve una función, se ejecuta cuando ese socket se retira:

```js
import { start } from 'zyrix'
import { createBot } from 'zyrix/kit'

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

Si necesitas escuchar eventos antes de arrancar, `createLauncher(options)` te da el lanzador sin iniciarlo y lo arrancas con `launcher.start()`.

### Eventos del lanzador

`socket`, `open`, `qr`, `pairing-code` (`code`, `formatted`), `status`, `issue`, `fatal`, `signal` y `stopped`.

`status` trae `{ state }`, que puede ser `connecting` (con `registered` y `phoneNumber`), `pairing`, `open`, `reconnecting` (con `reason`, `name` y `restart`) o `relaunching` (con `why`: `logged-out`, `bad-session`, `multidevice-mismatch`, `corrupt-session` o `session-deleted`).

`issue` avisa de problemas que no cortan la conexión. Su `type` puede ser `sender-key-miss` (se agrupa cada 10 s y trae `count`), `stream-error`, `connection-rejected`, `idle`, `timeout`, `save-error`, `setup-error`, `cleanup-error`, `session-deleted` o `error`.

`fatal` significa que la conexión no se puede recuperar sola. `reason` es el nombre de un `DisconnectReason` (`connectionReplaced`, `forbidden`, `clientOutdated`...) o uno de estos: `too-many-relaunches`, `invalid-phone`, `auth-error`, `connect-error`, `launch-error`. El proceso no se cierra solo.

### Opciones del lanzador

| Opción | Para qué sirve |
| --- | --- |
| `autoReset` (`true`) | Si WhatsApp cierra la sesión, la rechaza o está corrupta, borra la sesión local y vuelve a emparejar. Con `false` solo emite `fatal`. |
| `maxRelaunches`, `relaunchWindowMs` | Tope de relanzamientos. Por defecto 4 en 10 minutos. |
| `relaunchDelayMs` | Espera entre relanzamientos. |
| `watchSession`, `watchIntervalMs` | Detectan que alguien borró la carpeta de sesión. |
| `signals` | `true` o una lista. Cierra limpio con SIGINT, SIGTERM, SIGHUP y SIGTSTP y llama a `process.exit`, salvo que pongas `exit: false`. |
| `printCode` | Si nadie escucha `pairing-code`, imprime el código con formato `XXXX-XXXX`. |
| `connector` | Una función tuya para crear el socket. |

Todo lo demás se pasa al socket. Si usas un adaptador de sesión, el reinicio automático necesita que tenga un método `clear()`. Sin él, el lanzador emite `fatal`.

`launcher.stop()` cierra sin desvincular el dispositivo. `launcher.logout()` lo desvincula y borra la sesión. También hay utilidades sueltas: `parsePhoneNumber`, `formatPairingCode`, `promptPhone` y `reasonName`.

### Sin el lanzador

Si prefieres manejar tú la conexión:

```js
import { connect } from 'zyrix'

const sock = await connect({ session: './session', phoneNumber: '5215551234567' })
```

`session` puede ser una ruta o un [adaptador](#sesiones-y-store). `makeSocket(options)` es la forma más básica y recibe el `auth` ya armado.

## Hacer un bot con el kit de comandos

El kit es opcional y se importa aparte (`zyrix/kit`) para que el núcleo quede limpio. Si un handler lanza un error, el kit lo captura y el proceso sigue.

```js
import { connect } from 'zyrix'
import { createBot } from 'zyrix/kit'

const sock = await connect({ session: './session', phoneNumber: '5215551234567' })
const bot = createBot(sock, { prefix: ['!', '.'], owners: ['5215551234567'], cooldown: 3 })

bot.command(['ping', 'p'], (m) => m.reply('pong'), { description: 'latencia', category: 'utilidad' })
bot.command('kick', async (m) => sock.groups.kick(m.chat, m.mentions), { admin: true, botAdmin: true, group: true })
bot.command('registro', async (m) => {
  const answer = await m.ask('¿Cómo te llamas?')
  await m.reply(answer ? `Listo, ${answer.text}` : 'Se acabó el tiempo')
})

await bot.loadPlugins('./plugins', { watch: true })
```

### Comandos, hears y middlewares

`bot.command(nombres, handler, meta)` acepta en `meta`: `description`, `category`, `usage`, `group`, `private`, `admin`, `botAdmin`, `owner`, `hidden` y `cooldown` (en segundos). Para reaccionar a texto sin prefijo está `bot.hears(patrón, handler)`, y para middlewares `bot.use((m, next) => ...)`. `bot.help()` y `bot.menu()` generan el menú con el formato que quieras, y lo que devuelven `bot.list()` y `bot.menu()` usa siempre los nombres internos.

El kit no impone prefijos. Sin `prefix` solo sirve para `hears` y `use`, y registrar un comando lanza un `ZyrixError` de tipo `invalid`. Con `prefix: ''` los comandos se llaman sin prefijo. Cuando captures errores del kit, fíjate en `kind` y no en el texto del mensaje.

### Mensajes de rechazo y de error

El kit no envía textos propios. Si no defines las respuestas, no contesta nada. Las defines en `createBot(sock, { messages })` con estas claves: `groupOnly`, `privateOnly`, `ownerOnly`, `adminOnly`, `botAdmin`, `cooldown` y `error`. Cada una puede ser un texto o una función. Si prefieres hacerlo con tu propia lógica, escucha los eventos `command.denied` y `command.error`.

### Plugins

`bot.loadPlugins(dir, { watch, recursive })` carga los archivos `.js` y `.mjs` de una carpeta (ignora los que empiezan con `_`) y los recarga cuando los guardas. Un plugin puede exportar un objeto `{ commands, run, ...meta }`, un arreglo de objetos así, o una función `(bot) => {}`. En el último caso puedes llamar a `bot.onUnload(fn)` para limpiar lo que hayas creado.

Ojo: si cambias un módulo que el plugin importa, no se recarga solo. Solo se recarga el archivo del plugin.

### Vocabulario propio

No tienes que usar los nombres en inglés. Con la opción `vocabulary` (o `vocabulario`) de `createBot` le dices a Zyrix cómo llamas tú a cada cosa. Cada mapa va de tu nombre al nombre interno, y lo que no mapees sigue funcionando con el nombre original.

| Mapa | Qué renombra |
| --- | --- |
| `options` | las opciones de `createBot` |
| `command` | los metadatos y claves de un comando |
| `messages` | los textos de rechazo (también el `reason` de `command.denied`) |
| `hears` | las claves de `hears` |
| `plugin` | `setup`, `teardown`, `commands` y `hears` |
| `context` | lo que recibe el handler como segundo argumento |

```js
import { createBot, vocabularioEs } from 'zyrix/kit'

const bot = createBot(sock, { prefijo: '!', vocabulario: vocabularioEs, mensajes: { soloAdmin: 'Solo admins.' } })
bot.command('kick', async (m) => sock.groups.kick(m.chat, m.mentions), { soloAdmin: true, soloGrupo: true, botAdmin: true })

const propio = createBot(sock, { vocabulary: { options: { pref: 'prefix' }, command: { exige: 'admin' }, messages: { exige: 'adminOnly' } }, pref: '#' })
```

`vocabularioEs` es un preset en español: `soloAdmin`, `soloGrupo`, `soloPrivado`, `soloDueno`, `oculto`, `descripcion`, `categoria`, `uso`, `ejecutar`, `nombres`, `espera`, `prefijo`, `mensajes`, `patron`, `comandos`, `escuchar`, `preparar`, `limpiar`, `texto`, `argumentos`, entre otros. Puedes copiarlo y modificarlo, o armar uno desde cero.

### Eventos del bot

`command`, `command.error`, `command.denied`, `command.unknown`, `plugin.loaded`, `plugin.unloaded` y `plugin.error`.

## Recibir mensajes y eventos

### El mensaje con contexto

`sock.on('message', (m) => ...)` te entrega un `MessageContext`: todo lo que devuelve `parseMessage` más varias acciones ya listas.

- Acciones: `reply`, `say`, `react`, `unreact`, `delete`, `edit`, `forward`, `read`, `download`, `typing`, `group`, `isAdmin`, `isBotAdmin`, `getQuoted` y `ask`.
- Propiedades: `number`, `isMentioned` y `hasMedia`.

El evento `messages.upsert` se sigue emitiendo igual, por si lo prefieres.

Las ediciones, borrados, reacciones y votos de encuesta no llegan como `message`. Tienen sus propios eventos: `message.edit`, `message.revoke`, `message.reaction` y `poll.vote`. El voto llega sin descifrar, en `raw`.

### Conversaciones

`sock.waitForMessage(filtro, timeout)` y `m.ask(texto, { timeout, filter, strict })` esperan una respuesta. Si nadie contesta devuelven `null`, o lanzan un `ZyrixError` de tipo `timeout` si usas `strict: true`.

### Errores dentro de listeners

El socket usa `captureRejections`. Si un listener `async` lanza un error, llega al evento `error` y no se convierte en un `unhandledRejection`.

### parseMessage

`parseMessage(evento)` (también disponible como `socket.parseMessage`) convierte un `messages.upsert` en un objeto como `{ chat, sender, senderAlt, isGroup, type, text, mentions, quoted, media, offline, ... }`. El `quoted` se puede pasar directo a `reply`.

### Todos los eventos del socket

`open`, `close`, `qr`, `pairing-code`, `connection.update`, `messages.upsert`, `receipt`, `contacts.upsert`, `chats.update`, `app-state.mutation`, `groups.update`, `group-participants.update` (`add`, `remove`, `promote`, `demote`, `leave`), `presence.update`, `call`, `identity.changed`, `send.warning` y `error`.

`connection.update` junta el estado de la conexión en `{ connection: 'connecting' | 'open' | 'close', qr, isNewLogin, lastDisconnect }`. Los mensajes que llegan de la cola offline traen `offline: true`, que sirve para ignorar comandos viejos después de reconectar.

Si vienes de Baileys: `sock.ev` es un alias del propio emisor (`sock.ev.on(...)` hace lo mismo que `sock.on(...)`), `sock.user` es `auth.state.creds.me` y `sock.authState` es el estado de autenticación de la conexión.

## Enviar mensajes

### Métodos

| Para | Métodos |
| --- | --- |
| Texto | `sendMessage(jid, content, options?)`, `sendText(jid, text, options?)` |
| Responder citando | `reply(to, text, quoted)` |
| Botones, listas y encuestas | `sendButtons`, `sendInteractive`, `sendList`, `sendPoll` |
| Otros formatos | `sendReaction`, `sendLocation`, `sendContact`, `sendContacts`, `sendMedia` |
| Atajos de media | `sendImage`, `sendVideo`, `sendAudio`, `sendDocument`, `sendSticker` |
| Borrar y editar | `sendDelete(jid, target)`, `sendEdit(jid, target, text)` |
| Reenviar e invitar | `forward(jid, mensaje)`, `sendGroupInvite` |
| Álbumes y paquetes de stickers | `sendAlbum(jid, items)`, `sendStickerPack(jid, { pack, name, publisher, stickers })` |

Las opciones comunes son `quoted` (un evento con `key` y `message`), `mentions` y `contextInfo`. También existen `expiration` (mensajes temporales), `viewOnce` (imagen, vídeo o audio) y `linkPreview`. Las imágenes, vídeos y documentos aceptan `caption`.

Si el grupo tiene mensajes temporales y no indicas `expiration`, Zyrix usa la duración del grupo. Para eso necesita tener la metadata del grupo en caché.

### Si vienes de Baileys

`sendMessage` mira la forma del contenido y lo manda al método que corresponde. Entiende `{ image, caption }`, `{ video, caption }`, `{ audio, ptt }`, `{ document, fileName }`, `{ sticker }`, `{ buttons, text }`, `{ list }`, `{ poll }`, `{ location }`, `{ contact }`, `{ contacts }`, `{ delete: key }` y `{ edit: key, text }`. También acepta objetos protobuf completos.

### Confirmación de envío

`sendMessage` y los `send*` esperan el ack del servidor y devuelven `{ key, message, status, messageTimestamp }`. El `status` es `'sent'`, o `'unconfirmed'` si pasaron 30 segundos sin ack. Si el servidor rechaza el mensaje se lanza un error con `code`. Si no se puede cifrar para ningún dispositivo del destinatario, también se lanza un error en lugar de enviar en silencio, y los dispositivos que se omitieron se avisan con el evento `send.warning`.

### Media

Los tipos son `image`, `video`, `audio`, `document` y `sticker`. Puedes pasar un Buffer, un `Uint8Array`, una ruta, una URL, `{ url }`, `{ path }` o `{ stream }`, siempre dentro de `maxMediaBytes` (100 MiB por defecto). Si pasas un stream, Zyrix lo lee completo y lo guarda en memoria antes de subirlo, así que no es una subida por streaming. También se aceptan `thumbnail`, `width`, `height`, `seconds` y `waveform`. Para descifrar un adjunto que te llega, usa `downloadMedia(message)`.

`sendAlbum` sube cada imagen o vídeo y los asocia con `MessageAssociation.MEDIA_ALBUM`. Devuelve los mensajes y los contadores de imágenes y vídeos. El protocolo no garantiza que todas las versiones de WhatsApp los muestren como una sola tarjeta.

Un paquete de stickers se crea con `content.stickerPack(...)`. El archivo `pack` tiene que contener el paquete, y cada entrada de `stickers` necesita su `fileName`, los emojis y, si quieres, metadatos. Los paquetes que recibas se descargan con `downloadMedia`.

### Constructores de contenido

Sirven para armar el mensaje sin enviarlo: `content.text`, `buttons`, `interactive`, `list`, `poll`, `location`, `contact`, `reaction`, `vcard({ name, number })` y `buildMessage`. Para leer mensajes recibidos están `content.extractText` y `content.unwrapMessage`.

Los botones, las listas y los mensajes interactivos dependen de lo que el servicio y el tipo de cuenta permitan. Comprueba que funcionan en tu caso antes de apoyarte en ellos.

## JID, PN y LID

WhatsApp tiene dos tipos de identificador: el que se basa en el teléfono (`123@s.whatsapp.net`, PN) y uno opaco (`9001@lid`, LID). En los grupos, a veces el `participant` llega como LID. Cuando el servidor también manda el teléfono, Zyrix guarda los dos:

```js
const meta = await socket.groupMetadata(groupJid)
const participant = await socket.getGroupParticipant(groupJid, '9001@lid')

participant.id          // identificador canónico, normalmente el LID
participant.lid         // 9001@lid
participant.phoneNumber // 123@s.whatsapp.net, si WhatsApp lo entregó
participant.username    // notify/name recibido, si existe
```

Los eventos de mensajes traen `participantAlt` y `remoteJidAlt` cuando Zyrix ya conoce el par PN/LID. En los comandos no compares strings a mano: usa `resolveJid`, `getJidAliases` e `isGroupAdmin`. Un LID no se convierte a teléfono por la fuerza. El teléfono solo aparece si WhatsApp entregó la equivalencia. Con `onWhatsApp(...numeros)` puedes comprobar números y, de paso, aprender pares PN/LID.

Utilidades de JID exportadas: `jidDecode`, `jidEncode`, `normalizeJid`, `jidNormalizedUser`, `jidWithoutDevice`, `jidType`, `isJidUser`, `isJidLid`, `isJidPN` e `isJidGroup`.

## Grupos, perfil, privacidad y más

`sock.groups`, `sock.privacy`, `sock.profile`, `sock.chats` y `sock.presence` agrupan los métodos por tema y, donde tiene sentido, aceptan uno o varios usuarios. Los métodos planos (`groupParticipantsUpdate`, `updatePrivacyCategory`, etc.) siguen existiendo.

```js
await sock.groups.add(jid, '5215551234567@s.whatsapp.net')
await sock.groups.onlyAdminsTalk(jid)
await sock.privacy.lastSeen('contacts')
await sock.chats.pin(jid)
sock.presence.typing(jid)
```

### Referencia

| Área | Métodos |
| --- | --- |
| Grupos | `groupCreate`, `groupMetadata`, `groupFetchAllParticipating`, `getGroupParticipant`, `getGroupAdmins`, `isGroupAdmin`, `groupParticipantsUpdate`, `groupUpdateSubject`, `groupUpdateDescription`, `groupSettingUpdate`, `groupLeave`, `groupInviteCode`, `groupRevokeInvite`, `groupAcceptInvite`, `groupGetInviteInfo`, `groupRequestParticipantsList`, `groupRequestParticipantsUpdate`, `groupToggleEphemeral`, `groupMemberAddMode`, `groupJoinApprovalMode` |
| Cuenta propia | `updateProfileName`, `updateProfileStatus`, `updateProfilePicture`, `removeProfilePicture`, `profilePictureUrl`, `fetchStatus`, `getBusinessProfile`, `fetchBlocklist`, `updateBlockStatus` |
| Privacidad | `fetchPrivacySettings`, `updateLastSeenPrivacy`, `updateOnlinePrivacy`, `updateProfilePicturePrivacy`, `updateStatusPrivacy`, `updateReadReceiptsPrivacy`, `updateGroupsAddPrivacy`, `updateMessagesPrivacy`, `updateCallPrivacy`, `updateDefaultDisappearingMode` |
| Recibos y presencia | `readMessages(keys)`, `sendReceipt`, `sendPresenceUpdate('available' \| 'unavailable' \| 'composing' \| 'recording' \| 'paused', jid?)`, `presenceSubscribe` |
| Chats y llamadas | `chatModify({ pin \| mute \| archive \| markRead }, jid)`, `rejectCall` (o la opción `autoRejectCalls`) |
| Sesión | `requestPairingCode`, `syncAppState`, `waitForOpen`, `logout`, `end` (devuelve una promesa que espera a que se guarde la sesión) |

`fetchStatus` solo consulta el estado de texto de un usuario. Todo esto depende de lo que la cuenta y el servidor permitan en cada momento.

El cambio de nombre del perfil usa el generador de parches `appStatePatch`, con LTHash, MAC de índice, MAC de valor, `snapshotMac` y `patchMac`, y guarda el estado por colección. Si todavía no llegó una clave de app-state, usa como respaldo el IQ de perfil.

## Sesiones y store

### Sesión en archivos

`useFileAuthState(dir, { debounceMs })` guarda las claves en un solo archivo, `state.json`, con escritura atómica, permisos `0600` y una copia `state.json.bak`. Los guardados son asíncronos y se agrupan según `debounceMs` (300 por defecto). `auth.flush()` espera a que terminen y se ejecuta solo en `end()`, en `logout()` y al salir del proceso. Si falla una escritura, te llega como evento `error`. Si había `creds.json` y `keys.json` de versiones anteriores, los lee y los migra al snapshot.

Esa carpeta es privada. No la subas a un repositorio ni la compartas.

### Adaptadores

`useAdapterAuthState(adapter)` acepta cualquier objeto con `{ read(), write(data) }`. Vienen incluidos `memoryAdapter()` y `mongoAdapter(collection, id)`, que funciona con el driver oficial de MongoDB. Si la sesión está corrupta lanza un error, en lugar de crear otra y hacerte perder el emparejamiento.

Hay un límite que conviene tener presente: el adaptador guarda el estado completo cada vez, agrupado por `debounceMs`, y todavía no escribe por clave. Eso incluye credenciales, sesiones Signal, sender keys y claves de app-state, y crece con la cantidad de contactos y grupos. Con `mongoAdapter` el documento no puede pasar de los 16 MB de MongoDB. Si manejas varias sesiones en un proceso, o cuentas con mucha actividad, usa un documento por sesión (el `id` de `mongoAdapter(collection, id)`), sube el `debounceMs` y vigila el tamaño de `state.json`.

### Store

`createStore(socket, { maxMessagesPerChat, maxChats })` guarda mensajes, chats, contactos, grupos y presencias con límites de memoria. Se puede volcar a disco con `writeToFile` y leer con `readFromFile`.

`makeInMemoryStore(options)` es otra opción, al estilo de los stores de Baileys. Lo enlazas con `store.bind(sock)` y trae `loadMessage`, `getMessage`, `getMessages`, `toJSON`, `fromJSON`, `writeToFile` y `readFromFile`.

Para poder responder a los recibos de reintento incluso después de reiniciar el proceso, pásale el store al socket:

```js
const sock = await makeSocket({ auth, getMessage: (key) => store.getMessage(key) })
```

## Conexión y reconexión

El evento `close` informa `{ reason, loggedOut, reconnecting }`. Hay razones terminales que no se reintentan: `401` (sesión cerrada), `403`, `405`, `411`, `440` (reemplazada por otra sesión) y `500` (sesión dañada). Con el resto reconecta usando backoff exponencial con jitter, salvo `515` (reinicio después de emparejar), que reconecta de inmediato.

El keepalive cierra y reinicia la conexión después de dos pings fallidos o de 80 segundos sin recibir datos. Las opciones para ajustar todo esto son `reconnect`, `maxReconnectAttempts`, `keepAliveIntervalMs` y `queryTimeoutMs`.

`end()` se puede llamar más de una vez sin problema y detiene la reconexión automática. Si el socket detecta un error de descifrado Noise o de parsing del protocolo, cierra y programa una reconexión.

## Errores

Los errores propios son `ZyrixError`. Tienen un `kind` (`timeout`, `closed`, `not-ready`, `rejected`, `invalid`, `no-session`, `decrypt`, `media` o `auth`), un `code` cuando lo manda el servidor y un `retryable`. `ErrorKind` e `isZyrixError` están exportados.

```js
try {
  await sock.sendText(jid, 'hola')
} catch (error) {
  if (isZyrixError(error, ErrorKind.REJECTED)) console.log(error.code)
  else if (error.retryable) reintentar()
}
```

## Seguridad

### Opciones del socket

Además de las de conexión, `makeSocket` acepta:

| Opción | Descripción |
| --- | --- |
| `browser` | `[sistema, navegador, versión]`. Por defecto `['Mac OS', 'Chrome', '4.0.0']`. Se usa para armar el `UserAgent`, el `webInfo` y los `DeviceProps` del registro. |
| `maxMediaBytes` | Límite de tamaño de media. 100 MiB por defecto, para no gastar memoria sin querer. |
| `logger` | Tu propio logger. |
| `getMessage` | Recupera mensajes para contestar recibos de reintento. |
| `autoRejectCalls` | Rechaza las llamadas automáticamente. |
| `markOnlineOnConnect` | Con `false`, el teléfono sigue recibiendo notificaciones. |
| `syncFullHistory` | `false` por defecto. |
| `minSendIntervalMs` | Intervalo mínimo entre envíos. |
| `trustPolicy` | Qué hacer cuando cambia la identidad de un dispositivo (ver abajo). |
| `sentCacheSize`, `groupCacheSize` | Tamaño de las cachés. |

```js
const socket = await makeSocket({ auth, browser: ['Mac OS', 'Chrome', '4.0.0'], maxMediaBytes: 25 * 1024 * 1024 })
```

### trustPolicy

Controla qué pasa cuando un dispositivo Signal que ya conocías aparece con una identidad nueva.

- `'update'` (por defecto) acepta la identidad nueva, la reemplaza y emite `identity.changed`. Es lo que un bot necesita cuando un contacto reinstala WhatsApp.
- `'tofu'` rechaza el cambio, y el descifrado falla hasta que borres la sesión de ese dispositivo.
- Una función `(id, nueva, guardada) => boolean` te deja decidir caso por caso.

Cada cambio de identidad, aceptado o rechazado, emite `identity.changed` con `{ id, accepted }`. El `id` es el identificador Signal del dispositivo (`usuario.dispositivo`). Vale la pena escucharlo. Un cambio de identidad es normal si alguien reinstaló WhatsApp, pero también es lo que verías si hubiera un intermediario.

```js
sock.on('identity.changed', ({ id, accepted }) => {
  console.log(`identidad de ${id} cambió, aceptada: ${accepted}`)
})

const sock = await makeSocket({
  auth,
  trustPolicy: async (id, nueva, guardada) => owners.has(id.split('.')[0])
})
```

Si tu bot solo atiende a contactos conocidos o maneja información sensible, usa `'tofu'` o una función que decida por usuario. Con `'update'` aceptas cualquier clave nueva sin intervenir.

### Otras protecciones

Los mensajes entrantes que ya se procesaron se descartan por id durante 10 minutos, para que una reentrega del servidor no genere errores ni reintentos. Al sacar a alguien de un grupo, se rota la sender key propia de ese grupo. Las notificaciones de cambio de dispositivos invalidan la caché de dispositivos, y las de `encrypt` reponen prekeys.

## Business, canales y comunidades

### Business

Para cuentas que tengan esas capacidades, el socket incluye `getCatalog({ jid?, limit?, cursor? })`, `getCollections(jid?, limit?)`, `getOrderDetails(orderId, tokenBase64)`, `productCreate(product)`, `productUpdate(productId, update)`, `productDelete(productIds)`, `updateBusinessProfile(profile)`, `updateCoverPhoto(image)` y `removeCoverPhoto(id)`.

Los mismos métodos, con nombres más cortos, están en `sock.business`: `catalog`, `collections`, `orderDetails`, `createProduct`, `updateProduct`, `deleteProducts`, `profile`, `coverPhoto`, `removeCoverPhoto` y `getProfile`.

Para crear un producto entrega `name`, `description`, `price`, `currency` e `images`. Las imágenes aceptan las mismas entradas que `MediaInput` y se suben a la ruta de catálogo de WhatsApp.

```js
await sock.business.createProduct({ name: 'Taza', description: 'Cerámica', price: 12.5, currency: 'USD', images: ['./taza.jpg'] })
```

Que funcione depende de la cuenta y del protocolo del servidor, así que pruébalo primero con una cuenta de prueba. Esto usa el protocolo de dispositivos vinculados de WhatsApp Web. No es la WhatsApp Business Platform ni la Cloud API.

### Canales y comunidades

`sock.newsletters` tiene `create`, `metadata`, `follow`, `unfollow`, `mute` y `unmute`. `sock.communities` tiene `create`, `linkGroups`, `unlinkGroup` y `subgroups`. Son funciones de WhatsApp Web y dependen de que la cuenta y el servidor admitan la operación.

## Usarlo desde otros lenguajes

Zyrix corre en Node.js y está escrito en JavaScript, con declaraciones de TypeScript para el editor y la verificación estática. Python, Go, Rust y otros lenguajes no pueden importarlo directamente. Si tu bot está en otro lenguaje, tienes que escribir un cliente en ese lenguaje o correr Zyrix en Node detrás de un servicio con una API de red. Ese puente no viene en este paquete.

Si haces el puente, protégelo con control de acceso y no expongas las claves de la sesión al cliente remoto.

## Lo que todavía no hace

- **Publicar estados.** No hay método para publicar texto o media en `status@broadcast`.
- **Votos de encuestas.** `poll.vote` entrega el dato crudo. Zyrix no lo descifra ni lo relaciona con las opciones de la encuesta.
- **Migrar sesiones de PN a LID.** Se conservan los alias PN/LID que se conocen, pero las sesiones criptográficas de Signal no se migran de un identificador a otro.
- **Media vencida.** `downloadMedia` falla si el enlace ya expiró. No pide una nueva carga ni reintenta a través del teléfono vinculado.
- **Media por streaming.** `MediaInput` acepta `{ stream }` y hay código auxiliar para transformar por bloques, pero el envío y la descarga no están conectados como una API de streaming. Todo se acumula en memoria, dentro de `maxMediaBytes`. No existen `sendMediaStream` ni `downloadMediaStream`.
- **Colas por chat.** `PartitionedSendQueue` existe como utilidad interna, pero `Socket` no la usa. Los envíos pasan por una cola global para proteger el estado de Signal.
- **Guardado por clave.** Los adaptadores guardan el estado completo (ver [Sesiones y store](#sesiones-y-store)).

## Validación con WhatsApp real

Las pruebas automáticas no tocan los servidores de WhatsApp, y el protocolo puede cambiar sin aviso. Antes de confiar en una versión, vincula una cuenta de prueba (no tu cuenta principal) y déjala corriendo unos días. Esto es lo que yo revisaría:

- Emparejar por QR y por código, reiniciar el proceso y ver que la sesión se recupera sin volver a vincular.
- Escribirle a contactos nuevos y a contactos que reinstalan WhatsApp (`identity.changed`).
- Probar grupos grandes: enviar, recibir, agregar y quitar participantes, y confirmar que la sender key rota.
- Mandar y recibir cada tipo de media, y probar ediciones, borrados y reacciones.
- Cortar la red, matar el proceso y dejar el bot offline un rato, para ver cómo se comporta la reconexión, la cola offline y los recibos de reintento.
- Fijarte en que no haya errores de descifrado repetidos ni mensajes sin entregar (`status: 'unconfirmed'`).

### Licencia

Zyrix se distribuye bajo la licencia GNU GPL v3 (`GPL-3.0-only`). El texto completo está en [`LICENSE`](./LICENSE). Es GPL porque depende de `libsignal`, que es GPL-3.0: cualquier programa que distribuya Zyrix junto con esa dependencia tiene que poder distribuirse bajo una licencia compatible con GPL-3.0.

Si solo usas Zyrix para correr un bot propio en tu servidor, sin repartir el programa a otras personas, no tienes que publicar tu código. Esto es una guía general y no asesoría legal. Si necesitas otra licencia, el camino es reemplazar `libsignal` por una implementación de Signal con una licencia que te sirva.

### Avisos de terceros

Las atribuciones y licencias de las dependencias están en [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md).
