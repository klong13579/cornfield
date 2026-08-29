import type { Socket } from "net";

const MAX_FRAME_BYTES = 1024 * 1024;
/**
 * Write-side backpressure guard: a peer that stops reading will otherwise
 * accumulate unbounded bytes in the socket's write buffer (Bun queues without
 * limit; observed +45 MiB in probing). Cap the pending write buffer and tear
 * the connection down past it — a peer this far behind can only recover by
 * reconnecting.
 */
const MAX_PENDING_WRITE_BYTES = 8 * 1024 * 1024;

/**
 * Serialize a message into a length-prefixed frame, or return null when it
 * does not fit (JSON.stringify failure, undefined, or payload over
 * MAX_FRAME_BYTES). Write-side guard: the reader enforces the same 1 MiB cap
 * on the OTHER side, and delivering an over-limit frame would kill the
 * recipient's connection. Callers that can reject beforehand (the broker's
 * send path) should check this before writing.
 */
export function serializeMessageToFrame(msg: unknown): Buffer | null {
	let json: string;
	try {
		json = JSON.stringify(msg);
	} catch {
		return null;
	}
	if (json === undefined) {
		return null;
	}
	const payloadLength = Buffer.byteLength(json, "utf-8");
	if (payloadLength > MAX_FRAME_BYTES) {
		return null;
	}
	const frame = Buffer.allocUnsafe(4 + payloadLength);
	frame.writeUInt32BE(payloadLength, 0);
	frame.write(json, 4, payloadLength, "utf-8");
	return frame;
}

/**
 * Write a length-prefixed message to a socket.
 * Format: 4-byte big-endian length + JSON payload
 */
export function writeMessage(socket: Socket, msg: unknown): void {
	const frame = serializeMessageToFrame(msg);
	if (frame === null) {
		throw new Error("Intercom message does not fit in a 1 MiB frame");
	}
	if (socket.writableLength + frame.length > MAX_PENDING_WRITE_BYTES) {
		socket.destroy(new Error(`Intercom slow consumer: write buffer exceeds ${MAX_PENDING_WRITE_BYTES} bytes`));
		return;
	}
	socket.write(frame);
}

/**
 * Create a message reader that handles partial reads.
 * Calls onMessage for each complete message received.
 * Protocol or handler errors are reported to onError so the caller can close the socket.
 */
export function createMessageReader(
	onMessage: (msg: unknown) => void,
	onError: (error: Error) => void,
	maxFrameBytes = MAX_FRAME_BYTES,
) {
	const header = Buffer.allocUnsafe(4);
	let headerBytes = 0;
	let payload: Buffer | null = null;
	let payloadBytes = 0;
	let payloadLength = 0;

	function reportMessage(framePayload: Buffer): boolean {
		let msg: unknown;
		try {
			msg = JSON.parse(framePayload.toString("utf-8"));
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			onError(new Error(`Failed to parse intercom message: ${message}`, { cause: error }));
			return false;
		}

		try {
			onMessage(msg);
			return true;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			onError(new Error(`Failed to handle intercom message: ${message}`, { cause: error }));
			return false;
		}
	}

	return (data: Buffer) => {
		let offset = 0;

		while (offset < data.length) {
			if (headerBytes < 4) {
				const bytes = Math.min(4 - headerBytes, data.length - offset);
				data.copy(header, headerBytes, offset, offset + bytes);
				headerBytes += bytes;
				offset += bytes;
				if (headerBytes < 4) {
					return;
				}

				payloadLength = header.readUInt32BE(0);
				if (payloadLength > maxFrameBytes) {
					headerBytes = 0;
					onError(new Error(`Intercom frame length ${payloadLength} exceeds maximum ${maxFrameBytes} bytes`));
					return;
				}
			}

			// Fast path: the whole payload is already in this chunk, so parse it
			// in place without copying into a reassembly buffer.
			if (payloadBytes === 0 && data.length - offset >= payloadLength) {
				const framePayload = data.subarray(offset, offset + payloadLength);
				offset += payloadLength;
				headerBytes = 0;
				payload = null;
				payloadLength = 0;
				if (!reportMessage(framePayload)) {
					return;
				}
				continue;
			}

			// A buffer allocated for a previous frame (e.g. when a chunk ended
			// exactly on a header boundary) must not be reused for a frame of a
			// different size, so the reassembly buffer is size-checked, not just
			// presence-checked.
			if (payload === null || payload.length !== payloadLength) {
				payload = Buffer.allocUnsafe(payloadLength);
			}
			const bytes = Math.min(payloadLength - payloadBytes, data.length - offset);
			data.copy(payload, payloadBytes, offset, offset + bytes);
			payloadBytes += bytes;
			offset += bytes;

			if (payloadBytes < payloadLength) {
				return;
			}

			const framePayload = payload;
			headerBytes = 0;
			payload = null;
			payloadBytes = 0;
			payloadLength = 0;
			if (!reportMessage(framePayload)) {
				return;
			}
		}
	};
}
