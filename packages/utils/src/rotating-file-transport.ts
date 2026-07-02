/**
 * Bun-native rotating file transport for winston.
 *
 * Replaces `winston-daily-rotate-file` + `file-stream-rotator`, which leak
 * file descriptors under Bun: `stream.end()` is async and the rotator
 * immediately opens a new `fs.createWriteStream` without waiting for the
 * old FD to close. Over time (especially in a tight render loop after an
 * abort), dozens of orphaned FDs accumulate.
 *
 * This transport uses `Bun.file().writer()` (Bun.FileSink) which provides
 * synchronous `write()` and `end()` with reliable FD lifecycle management.
 *
 * Features:
 *   - Date-based filenames: `omp.YYYY-MM-DD.log`
 *   - Size-based rotation: rename to `omp.YYYY-MM-DD.log.N` when exceeding `maxSize`
 *   - `maxFiles` retention: deletes oldest rotated files
 *   - No audit file (retention is managed inline on rotation)
 */
import * as fs from "node:fs";
import * as path from "node:path";
import Transport from "winston-transport";
import { MESSAGE } from "triple-beam";

export interface RotatingFileTransportOptions extends Transport.TransportStreamOptions {
	/** Directory for log files. */
	dirname: string;
	/** Filename pattern with `%DATE%` placeholder. */
	filename: string;
	/** Date format for `%DATE%` substitution (moment.js format, e.g. "YYYY-MM-DD"). */
	datePattern: string;
	/** Max file size before rotation (e.g. "100m", "10k", "1g"). */
	maxSize: string;
	/** Max number of rotated files to keep. */
	maxFiles: number;
}

const SIZE_UNITS: Record<string, number> = { k: 1024, m: 1024 * 1024, g: 1024 * 1024 * 1024 };

function parseSize(size: string): number {
	const match = size.toLowerCase().match(/^(\d+(?:\.\d+)?)([kmg])$/);
	if (!match) return Infinity;
	return Math.floor(parseFloat(match[1]) * SIZE_UNITS[match[2]]);
}

function formatDate(date: Date, pattern: string): string {
	const replacements: Record<string, string> = {
		YYYY: String(date.getFullYear()),
		MM: String(date.getMonth() + 1).padStart(2, "0"),
		DD: String(date.getDate()).padStart(2, "0"),
		HH: String(date.getHours()).padStart(2, "0"),
		mm: String(date.getMinutes()).padStart(2, "0"),
		ss: String(date.getSeconds()).padStart(2, "0"),
	};
	let result = pattern;
	for (const [token, value] of Object.entries(replacements)) {
		result = result.replace(token, value);
	}
	return result;
}

export class RotatingFileTransport extends Transport {
	readonly #dirname: string;
	readonly #filenamePattern: string;
	readonly #datePattern: string;
	readonly #maxBytes: number;
	readonly #maxFiles: number;

	#writer: Bun.FileSink | null = null;
	#currentPath: string;
	#currentDate: string;
	#currentSize = 0;

	constructor(options: RotatingFileTransportOptions) {
		super(options);
		this.#dirname = options.dirname;
		this.#filenamePattern = options.filename;
		this.#datePattern = options.datePattern;
		this.#maxBytes = parseSize(options.maxSize);
		this.#maxFiles = options.maxFiles;

		fs.mkdirSync(this.#dirname, { recursive: true });
		this.#currentDate = formatDate(new Date(), this.#datePattern);
		this.#currentPath = this.#buildPath(this.#currentDate);
		this.#open();
	}

	#buildPath(dateStr: string, rotationIndex?: number): string {
		const filename = this.#filenamePattern.replace("%DATE%", dateStr);
		const suffix = rotationIndex !== undefined ? `.${rotationIndex}` : "";
		return path.join(this.#dirname, `${filename}${suffix}`);
	}

	#open(): void {
		this.#writer = Bun.file(this.#currentPath).writer();
		try {
			const stat = fs.statSync(this.#currentPath);
			this.#currentSize = stat.size;
		} catch {
			this.#currentSize = 0;
		}
	}

	#rotate(): void {
		// Flush and close the current writer.
		this.#writer?.flush();
		this.#writer?.end();
		this.#writer = null;

		// Rename current file to .1, shift existing .N to .N+1.
		this.#shiftRotatedFiles();

		// Open new file with the same date (size rotation keeps the date).
		this.#currentPath = this.#buildPath(this.#currentDate);
		this.#currentSize = 0;
		this.#open();

		// Enforce maxFiles retention.
		this.#pruneOldFiles();
	}

	#shiftRotatedFiles(): void {
		// Rename omp.YYYY-MM-DD.log → omp.YYYY-MM-DD.log.1
		// Shift existing .N → .N+1, up to maxFiles-1
		const baseName = this.#filenamePattern.replace("%DATE%", this.#currentDate);
		for (let i = this.#maxFiles - 1; i >= 1; i--) {
			const from = path.join(this.#dirname, `${baseName}.${i}`);
			const to = path.join(this.#dirname, `${baseName}.${i + 1}`);
			try {
				fs.renameSync(from, to);
			} catch {
				// File may not exist — skip.
			}
		}
		try {
			fs.renameSync(this.#currentPath, path.join(this.#dirname, `${baseName}.1`));
		} catch {
			// If rename fails (e.g. file already moved), continue.
		}
	}

	#pruneOldFiles(): void {
		const baseName = this.#filenamePattern.replace("%DATE%", this.#currentDate);
		let entries: string[];
		try {
			entries = fs.readdirSync(this.#dirname);
		} catch {
			return;
		}
		// Collect rotated files for the current date: baseName.N
		const rotated: { index: number; name: string }[] = [];
		for (const name of entries) {
			const match = new RegExp(`^${escapeRegex(baseName)}\\.(\\d+)$`).exec(name);
			if (match) {
				rotated.push({ index: parseInt(match[1], 10), name });
			}
		}
		rotated.sort((a, b) => b.index - a.index);
		// Delete files beyond maxFiles-1 (we keep .1 through .maxFiles-1).
		for (const file of rotated) {
			if (file.index >= this.#maxFiles) {
				try {
					fs.unlinkSync(path.join(this.#dirname, file.name));
				} catch {
					// ignore
				}
			}
		}
	}

	#checkDateRotation(): void {
		const newDate = formatDate(new Date(), this.#datePattern);
		if (newDate !== this.#currentDate) {
			this.#currentDate = newDate;
			// Date changed — close current writer, open new date file.
			// No renaming needed; the old date file stays as-is.
			this.#writer?.flush();
			this.#writer?.end();
			this.#writer = null;
			this.#currentPath = this.#buildPath(this.#currentDate);
			this.#currentSize = 0;
			this.#open();
		}
	}

	override log(info: any, callback: () => void): void {
		if (this.silent) {
			callback();
			return;
		}

		this.#checkDateRotation();

		const line = info[MESSAGE] + "\n";
		const lineBytes = Buffer.byteLength(line, "utf-8");

		// Check size rotation BEFORE writing so we don't exceed the limit.
		if (this.#currentSize + lineBytes > this.#maxBytes && this.#currentSize > 0) {
			this.#rotate();
		}

		this.#writer?.write(line);
		this.#currentSize += lineBytes;
		this.emit("logged", info);
		callback();
	}

	override close(): void {
		this.#writer?.flush();
		this.#writer?.end();
		this.#writer = null;
		this.emit("finish");
	}
}

function escapeRegex(str: string): string {
	return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
