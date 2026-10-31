import type { Socket, MessageContext } from './index.js'

export type CommandContext = { bot: Bot; sock: Socket; command: CommandEntry; prefix: string; args: string[]; text: string }
export type CommandHandler = (m: MessageContext, ctx: CommandContext) => unknown | Promise<unknown>
export type CommandMeta = {
  description?: string
  usage?: string
  category?: string
  group?: boolean
  private?: boolean
  admin?: boolean
  botAdmin?: boolean
  owner?: boolean
  hidden?: boolean
  cooldown?: number
}
export type CommandSpec = CommandMeta & { [custom: string]: unknown } & { name?: string; names?: string | string[]; command?: string | string[]; commands?: string | string[] | CommandSpec[]; run?: CommandHandler; handler?: CommandHandler; hears?: { pattern: RegExp | string | ((m: MessageContext) => unknown); run: CommandHandler; group?: boolean }[]; setup?(bot: Bot): unknown; teardown?(): void }
export type CommandEntry = Required<Omit<CommandMeta, 'cooldown' | 'category'>> & { category: string | null; id: string; names: string[]; cooldown?: number; run: CommandHandler; source: string | null }
export type BotMessageKey = 'groupOnly' | 'privateOnly' | 'ownerOnly' | 'adminOnly' | 'botAdmin' | 'cooldown' | 'error'
export type BotMessages = Partial<Record<BotMessageKey, string | ((value?: number) => string)>>
export type Vocabulary = { options?: Record<string, string>; command?: Record<string, string>; messages?: Record<string, string>; hears?: Record<string, string>; plugin?: Record<string, string>; context?: Record<string, string> }
export const vocabularioEs: Readonly<Required<Vocabulary>>
export type BotOptions = {
  vocabulary?: Vocabulary
  vocabulario?: Vocabulary
  prefix?: string | string[] | null
  owners?: (string | number)[]
  ignoreOffline?: boolean
  ignoreSelf?: boolean
  cooldown?: number
  autoRead?: boolean
  caseSensitive?: boolean
  messages?: BotMessages
} & { [custom: string]: unknown }
export type Middleware = (m: MessageContext, next: () => Promise<unknown>) => unknown

export type BotEventMap = {
  command: (e: { m: MessageContext; command: CommandEntry }) => void
  'command.error': (e: { m: MessageContext; command?: CommandEntry; error: Error }) => void
  'command.denied': (e: { m: MessageContext; command: CommandEntry; reason: string }) => void
  'command.unknown': (e: { m: MessageContext; name: string }) => void
  'plugin.loaded': (e: { file: string; commands: string[] }) => void
  'plugin.unloaded': (e: { file: string; commands: number }) => void
  'plugin.error': (e: { file: string; error: Error }) => void
}

export class Bot {
  constructor(sock: Socket, options?: BotOptions)
  readonly sock: Socket
  on<E extends keyof BotEventMap>(event: E, listener: BotEventMap[E]): this
  once<E extends keyof BotEventMap>(event: E, listener: BotEventMap[E]): this
  off<E extends keyof BotEventMap>(event: E, listener: BotEventMap[E]): this
  command(names: string | string[], handler: CommandHandler, meta?: CommandMeta & { [custom: string]: unknown }): this
  command(spec: CommandSpec): this
  hears(pattern: RegExp | string | ((m: MessageContext) => unknown), handler: CommandHandler, meta?: { group?: boolean }): this
  use(fn: Middleware): this
  onUnload(fn: () => void): this
  isOwner(m: MessageContext): boolean
  list(options?: { showHidden?: boolean }): CommandEntry[]
  menu(options?: { showHidden?: boolean }): { category: string | null; commands: CommandEntry[] }[]
  help(options?: { title?: string; uncategorized?: string; showHidden?: boolean; bullet?: string; dash?: string }): string
  loadPlugin(file: string): Promise<boolean>
  unloadPlugin(file: string): number
  loadPlugins(dir: string, options?: { watch?: boolean; recursive?: boolean }): Promise<{ loaded: string[]; failed: string[] }>
  watch(dir: string, options?: { recursive?: boolean }): this
  stop(): void
}

export function createBot(sock: Socket, options?: BotOptions): Bot
