/**
 * Minimal stdin/stdout ExtensionUIContext for the stage-test CLI.
 * Injectable IO for unit tests; defaults to process.stderr + readline stdin.
 */
import * as readline from "node:readline";
import type { ExtensionUIContext } from "@oh-my-pi/pi-coding-agent";

export interface StageCliIo {
	write(text: string): void;
	readLine(): Promise<string>;
}

export function createDefaultStageCliIo(): StageCliIo {
	const rl = readline.createInterface({
		input: process.stdin,
		output: process.stderr,
		terminal: Boolean(process.stdin.isTTY),
	});
	return {
		write(text: string) {
			process.stderr.write(text);
		},
		readLine() {
			return new Promise(resolve => {
				rl.question("", answer => {
					resolve(answer);
				});
			});
		},
	};
}

export function createStageCliUI(io: StageCliIo = createDefaultStageCliIo()): ExtensionUIContext {
	const input = async (title: string, _placeholder?: string): Promise<string | undefined> => {
		io.write(`\n${title}\n> `);
		const line = await io.readLine();
		const trimmed = line.trim();
		return trimmed.length === 0 ? undefined : trimmed;
	};

	const select = async (title: string, options: string[]): Promise<string | undefined> => {
		io.write(`\n${title}\n`);
		for (let i = 0; i < options.length; i++) {
			io.write(`  ${i + 1}) ${options[i]}\n`);
		}
		io.write("> ");
		const line = await io.readLine();
		const trimmed = line.trim();
		if (!trimmed) return undefined;
		const idx = Number(trimmed);
		if (Number.isInteger(idx) && idx >= 1 && idx <= options.length) {
			return options[idx - 1];
		}
		// Also accept exact option text
		const exact = options.find(o => o === trimmed);
		return exact;
	};

	const notify = (message: string, type: "info" | "warning" | "error" = "info"): void => {
		io.write(`[${type}] ${message}\n`);
	};

	return {
		select,
		input,
		confirm: async (title: string, message: string) => {
			const ans = await input(`${title}\n${message}\n[y/n]`, "y/n");
			if (!ans) return false;
			const lower = ans.toLowerCase();
			return lower === "y" || lower === "yes";
		},
		notify,
		onTerminalInput: () => () => {},
		setStatus: (_key, text) => {
			if (text) io.write(`[status] ${text}\n`);
		},
		setWorking: () => {},
		setWorkingMessage: msg => {
			if (msg) io.write(`[working] ${msg}\n`);
		},
		setEditorText: () => {},
		pasteEditorText: () => {},
		getEditorText: () => "",
		editor: async () => undefined,
		setCustomEditor: () => {},
		setWidget: () => {},
		setFooter: () => {},
		setHeader: () => {},
		setTitle: () => {},
		custom: async () => undefined as never,
	} as unknown as ExtensionUIContext;
}
