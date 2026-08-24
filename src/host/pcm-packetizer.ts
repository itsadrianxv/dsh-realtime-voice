import { OUTPUT_FRAME_BYTES } from '../protocol.ts'

/**
 * Response-scoped PCM packetizer. Provider delta boundaries are transport
 * details; downstream clients receive 40 ms packets plus one even-byte tail.
 */
export class ResponsePcmPacketizer {
  private readonly remainders = new Map<string, Uint8Array>()

  push(responseId: string, chunk: Uint8Array): Uint8Array[] {
    if (chunk.byteLength === 0) return []
    if (chunk.byteLength % 2 !== 0) {
      throw new Error(`provider PCM delta for ${responseId} contains an incomplete 16-bit sample`)
    }
    const previous = this.remainders.get(responseId)
    const combined = new Uint8Array((previous?.byteLength ?? 0) + chunk.byteLength)
    if (previous !== undefined) combined.set(previous)
    combined.set(chunk, previous?.byteLength ?? 0)

    const packets: Uint8Array[] = []
    let offset = 0
    while (combined.byteLength - offset >= OUTPUT_FRAME_BYTES) {
      packets.push(combined.slice(offset, offset + OUTPUT_FRAME_BYTES))
      offset += OUTPUT_FRAME_BYTES
    }
    if (offset === combined.byteLength) this.remainders.delete(responseId)
    else this.remainders.set(responseId, combined.slice(offset))
    return packets
  }

  flush(responseId: string): Uint8Array | undefined {
    const tail = this.remainders.get(responseId)
    this.remainders.delete(responseId)
    return tail?.slice()
  }

  discard(responseId: string): void {
    this.remainders.delete(responseId)
  }

  clear(): void {
    this.remainders.clear()
  }
}
