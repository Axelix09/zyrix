const DEFAULT_MESSAGES = Object.freeze({
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

export { DEFAULT_MESSAGES, mergeMessages }
