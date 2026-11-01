import type {
  AuthState,
  IncomingMessage,
  MessageContent,
  SendOptions,
  SendResult,
  Socket,
  SocketOptions,
} from './index.js'

export type ClientMessageOptions = SendOptions & {
  userJid?: string
}

export type CreateClientOptions = Partial<Omit<SocketOptions, 'auth'>> & {
  auth?: AuthState | AuthState['state']
  printQRInTerminal?: boolean
}

export type ClientSocket = Socket & {
  sendPrepared(
    jid: string,
    message: Record<string, unknown>,
    options?: ClientMessageOptions,
  ): Promise<SendResult>
}

export const clientProfiles: {
  ubuntu(browser?: string): [string, string, string]
}
export function fetchProtocolVersion(): Promise<{ version: [number, number, number] }>
export function useZyrixAuth(directory: string): Promise<{
  state: AuthState['state']
  saveCreds: AuthState['save']
  auth: AuthState
}>
export function createClient(options?: CreateClientOptions): ClientSocket
export function createMessageId(): string
export function createMessageEnvelope(
  jid: string,
  message: Record<string, unknown>,
  options?: ClientMessageOptions,
): IncomingMessage
export function createMessage(
  jid: string,
  content: MessageContent,
  options?: ClientMessageOptions,
): Promise<IncomingMessage>
export function createMessageContent(
  content: MessageContent,
  options?: SendOptions,
): Promise<Record<string, unknown>>
export function readMediaStream(
  sock: Socket,
  message: Record<string, unknown>,
  mediaType?: string,
): Promise<AsyncIterable<Uint8Array>>
export function attachMessageDelivery(sock: Socket): ClientSocket
