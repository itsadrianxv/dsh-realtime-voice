/**
 * Response-scoped PCM packetizer. Provider delta boundaries are transport
 * details; downstream clients receive 40 ms packets plus one even-byte tail.
 */
export declare class ResponsePcmPacketizer {
    private readonly remainders;
    push(responseId: string, chunk: Uint8Array): Uint8Array[];
    flush(responseId: string): Uint8Array | undefined;
    discard(responseId: string): void;
    clear(): void;
}
