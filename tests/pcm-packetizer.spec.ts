import { describe, expect, it } from 'vitest'
import { ResponsePcmPacketizer } from '../src/host/pcm-packetizer.ts'
import { OUTPUT_FRAME_BYTES } from '../src/protocol.ts'

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0))
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.byteLength
  }
  return result
}

describe('response PCM packetizer', () => {
  it('reassembles arbitrary even provider deltas into lossless 1920-byte packets and one even tail', () => {
    const source = Uint8Array.from({ length: OUTPUT_FRAME_BYTES * 3 + 514 }, (_, index) => index % 251)
    const splitSizes = [2, 38, 2_500, 4, 1_222, 2_000, source.byteLength]
    const packetizer = new ResponsePcmPacketizer()
    const packets: Uint8Array[] = []
    let offset = 0
    for (const requested of splitSizes) {
      if (offset === source.byteLength) break
      const size = Math.min(requested, source.byteLength - offset)
      const evenSize = size - (size % 2)
      if (evenSize === 0) continue
      packets.push(...packetizer.push('response-a', source.slice(offset, offset + evenSize)))
      offset += evenSize
    }
    if (offset < source.byteLength) packets.push(...packetizer.push('response-a', source.slice(offset)))
    const tail = packetizer.flush('response-a')

    expect(packets).toHaveLength(3)
    expect(packets.every(packet => packet.byteLength === OUTPUT_FRAME_BYTES)).toBe(true)
    expect(tail?.byteLength).toBe(514)
    expect(tail!.byteLength % 2).toBe(0)
    expect(concat([...packets, tail!])).toEqual(source)
  })

  it('rejects an odd provider delta instead of joining half a sample', () => {
    const packetizer = new ResponsePcmPacketizer()
    packetizer.push('response-a', new Uint8Array([1, 2]))
    expect(() => packetizer.push('response-a', new Uint8Array([3]))).toThrow(/incomplete 16-bit sample/)
    expect(packetizer.flush('response-a')).toEqual(new Uint8Array([1, 2]))
  })

  it('keeps simultaneous response remainders isolated', () => {
    const packetizer = new ResponsePcmPacketizer()
    packetizer.push('response-a', new Uint8Array([1, 2, 3, 4]))
    packetizer.push('response-b', new Uint8Array([9, 10, 11, 12]))
    expect(packetizer.flush('response-a')).toEqual(new Uint8Array([1, 2, 3, 4]))
    expect(packetizer.flush('response-b')).toEqual(new Uint8Array([9, 10, 11, 12]))
  })
})
