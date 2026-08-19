/** `ws` reports a successful send with `null`, despite older typings allowing `undefined`. */
export function isWebSocketSendError(error: Error | null | undefined): error is Error {
  return error != null
}
