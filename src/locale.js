const DEFAULT_MESSAGES = Object.freeze({
  disconnect: Object.freeze({
    connectionClosed: 'connection closed',
    connectionLost: 'connection lost',
    connectionReplaced: 'session replaced',
    loggedOut: 'logged out',
    forbidden: 'access denied',
    badSession: 'session rejected',
    restartRequired: 'restart requested by WhatsApp',
    multideviceMismatch: 'incompatible session',
    clientOutdated: 'outdated version',
    unavailableService: 'WhatsApp service unavailable',
    networkClosed: 'network dropped'
  }),
  fatal: Object.freeze({
    connectionReplaced: 'Another instance is using this same session; close the duplicate processes.',
    forbidden: 'WhatsApp blocked access (403); check whether the account or number is restricted.',
    clientOutdated: 'The WhatsApp Web version is outdated; update Zyrix.',
    'too-many-relaunches': 'Too many restarts in a row; stopping to avoid a ban.',
    'invalid-phone': 'Invalid number: it must have 8 to 15 digits, including the country code.'
  }),
  relaunch: Object.freeze({
    'logged-out': 'The session was closed from the phone. Deleting the local session.',
    'bad-session': 'WhatsApp rejected the saved session. Deleting the local session.',
    'multidevice-mismatch': 'The saved session does not match the account. Deleting the local session.',
    'corrupt-session': 'The saved session is corrupt; resetting it.',
    'session-deleted': 'The session folder was deleted while the bot was running.'
  }),
  issue: Object.freeze({
    'stream-error': (i, reason) => `WhatsApp reported a connection problem (${reason(i.code)}).`,
    'connection-rejected': (i, reason) => `WhatsApp rejected the connection (${reason(i.code)}).`,
    idle: () => 'The connection stopped responding; restarting.',
    timeout: () => 'A WhatsApp query took too long.',
    'sender-key-miss': (i) => `${i.count} group message(s) are waiting for their key; a resend was requested.`,
    'save-error': (i, errorText) => `Could not save the session: ${errorText(i.error)}`,
    'setup-error': (i, errorText) => `Bot setup failed: ${errorText(i.error)}`,
    error: (i, errorText) => errorText(i.error)
  }),
  signal: {
    SIGTSTP: 'Ctrl+Z detected: shutting down instead of suspending so no process is left hanging.',
    default: (signal) => `${signal} received; saving the session and shutting down.`
  }
})

// Textos en español, para quien prefiera los mensajes anteriores: mergeMessages(MESSAGES_ES)
const MESSAGES_ES = Object.freeze({
  disconnect: Object.freeze({
    connectionClosed: 'conexión cerrada',
    connectionLost: 'conexión perdida',
    connectionReplaced: 'sesión reemplazada',
    loggedOut: 'sesión cerrada',
    forbidden: 'acceso denegado',
    badSession: 'sesión rechazada',
    restartRequired: 'reinicio solicitado por WhatsApp',
    multideviceMismatch: 'sesión incompatible',
    clientOutdated: 'versión desactualizada',
    unavailableService: 'servicio de WhatsApp no disponible',
    networkClosed: 'se cortó la red'
  }),
  fatal: Object.freeze({
    connectionReplaced: 'Otra instancia está usando esta misma sesión; cierra los procesos duplicados.',
    forbidden: 'WhatsApp bloqueó el acceso (403); revisa si la cuenta o el número tienen restricciones.',
    clientOutdated: 'La versión de WhatsApp Web quedó desactualizada; actualiza Zyrix.',
    'too-many-relaunches': 'Demasiados reinicios seguidos; se detiene para evitar bloqueos.',
    'invalid-phone': 'Número inválido: deben ser entre 8 y 15 dígitos, incluido el código de país.'
  }),
  relaunch: Object.freeze({
    'logged-out': 'La sesión fue cerrada desde el teléfono. Se borra la sesión local.',
    'bad-session': 'WhatsApp rechazó la sesión guardada. Se borra la sesión local.',
    'multidevice-mismatch': 'La sesión guardada no es compatible con la cuenta. Se borra la sesión local.',
    'corrupt-session': 'La sesión guardada está corrupta; se restablece.',
    'session-deleted': 'La carpeta de sesión fue eliminada mientras el bot corría.'
  }),
  issue: Object.freeze({
    'stream-error': (i, reason) => `WhatsApp reportó un problema de conexión (${reason(i.code)}).`,
    'connection-rejected': (i, reason) => `WhatsApp rechazó la conexión (${reason(i.code)}).`,
    idle: () => 'La conexión dejó de responder; se reinicia.',
    timeout: () => 'Una consulta a WhatsApp tardó demasiado.',
    'sender-key-miss': (i) => `${i.count} mensaje(s) de grupo esperan su clave; se pidió reenvío.`,
    'save-error': (i, errorText) => `No se pudo guardar la sesión: ${errorText(i.error)}`,
    'setup-error': (i, errorText) => `Falló la inicialización del bot: ${errorText(i.error)}`,
    error: (i, errorText) => errorText(i.error)
  }),
  signal: {
    SIGTSTP: 'Ctrl+Z detectado: se cierra en vez de suspender para no dejar procesos colgados.',
    default: (signal) => `${signal} recibido; guardando la sesión y cerrando.`
  }
})

const mergeMessages = (custom = {}) => ({
  ...DEFAULT_MESSAGES,
  ...custom,
  disconnect: { ...DEFAULT_MESSAGES.disconnect, ...(custom.disconnect || {}) },
  fatal: { ...DEFAULT_MESSAGES.fatal, ...(custom.fatal || {}) },
  relaunch: { ...DEFAULT_MESSAGES.relaunch, ...(custom.relaunch || {}) },
  issue: { ...DEFAULT_MESSAGES.issue, ...(custom.issue || {}) },
  signal: { ...DEFAULT_MESSAGES.signal, ...(custom.signal || {}) }
})

export { DEFAULT_MESSAGES, MESSAGES_ES, mergeMessages }
