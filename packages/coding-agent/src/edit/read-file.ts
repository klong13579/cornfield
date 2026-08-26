/**
 * Shared file-read helper for edit-mode utilities.
 *
 * Reads a file via Bun and rethrows ENOENT as a user-facing "File not found"
 * error referencing the display path.
 */
import * as fs from "node:fs/promises";
import { isEnoent } from "@oh-my-pi/pi-utils";

export async function readEditFileText(absolutePath: string, path: string): Promise<string> {
	// Bun.file().text() strips a UTF-8 BOM during decoding; the edit pipeline
	// (stripBom → replace → bom + restore) relies on the raw bytes to re-emit it.
	// fs.readFile keeps the BOM character.
	try {
		return await fs.readFile(absolutePath, "utf8");
	} catch (error) {
		if (isEnoent(error)) {
			throw new Error(`File not found: ${path}`);
		}
		throw error;
	}
}
