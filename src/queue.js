export class PartitionedSendQueue {
  constructor(options = {}) {
    this.queues = new Map()
    this.idleTimeoutMs = options.idleTimeoutMs ?? 15000
    this.timers = new Map()
  }

  async run(chatJid, task) {
    if (!chatJid || typeof task !== 'function') {
      throw new Error('PartitionedSendQueue.run requiere chatJid y una función tarea')
    }

    if (this.timers.has(chatJid)) {
      clearTimeout(this.timers.get(chatJid))
      this.timers.delete(chatJid)
    }

    const previous = this.queues.get(chatJid) || Promise.resolve()

    const current = previous
      .catch(() => {})
      .then(async () => {
        return await task()
      })

    this.queues.set(chatJid, current)

    try {
      return await current
    } finally {
      if (this.queues.get(chatJid) === current) {
        const timer = setTimeout(() => {
          if (this.queues.get(chatJid) === current) {
            this.queues.delete(chatJid)
          }
          this.timers.delete(chatJid)
        }, this.idleTimeoutMs)
        if (typeof timer.unref === 'function') timer.unref()
        this.timers.set(chatJid, timer)
      }
    }
  }

  clear() {
    for (const timer of this.timers.values()) {
      clearTimeout(timer)
    }
    this.timers.clear()
    this.queues.clear()
  }

  activeChats() {
    return Array.from(this.queues.keys())
  }
}