/**
 * Chess game arbiter. Owns the board via the vendored chess.js, applies and
 * validates moves from players, tracks history, detects game end, and builds
 * the per-turn move request prompt.
 */

import Handlebars from "handlebars";
import { Chess } from "./vendor/chess.js";
import movePromptTemplate from "../prompts/chess-move.md" with { type: "text" };

export type Side = "w" | "b";

export interface AppliedMove {
	san: string;
	from: string;
	to: string;
	before: string;
	after: string;
}

export interface MoveReply {
	san: string;
	text: string;
	illegal: boolean;
	reason?: string;
}

export interface GameStatus {
	over: boolean;
	reason: string;
	winner?: string;
}

const movePrompt = Handlebars.compile(movePromptTemplate);

export class ChessGame {
	private readonly game: Chess;
	readonly history: AppliedMove[] = [];

	constructor(fen?: string) {
		this.game = fen ? new Chess(fen) : new Chess();
	}

	fen(): string {
		return this.game.fen();
	}

	turn(): Side {
		return this.game.turn();
	}

	sideName(): string {
		return this.game.turn() === "w" ? "white" : "black";
	}

	ascii(): string {
		return this.game.ascii();
	}

	moveNumber(): number {
		return this.game.moveNumber();
	}

	/** Apply an already-validated SAN. Throws on illegal input. */
	applyMove(san: string): AppliedMove {
		const move = this.game.move(san);
		if (!move) throw new Error(`illegal move: ${san}`);
		const applied: AppliedMove = {
			san: move.san,
			from: move.from,
			to: move.to,
			before: move.before,
			after: move.after,
		};
		this.history.push(applied);
		return applied;
	}

	status(): GameStatus {
		const game = this.game;
		if (game.isCheckmate()) {
			return { over: true, reason: "checkmate", winner: game.turn() === "w" ? "black" : "white" };
		}
		if (game.isStalemate()) return { over: true, reason: "stalemate" };
		if (game.isThreefoldRepetition()) return { over: true, reason: "threefold repetition" };
		if (game.isInsufficientMaterial()) return { over: true, reason: "insufficient material" };
		if (game.isDraw()) return { over: true, reason: "draw" };
		return { over: false, reason: "" };
	}

	legalMoves(): string[] {
		const moves = this.game.moves();
		return Array.isArray(moves) ? (moves as string[]) : [];
	}

	randomLegalMove(): string {
		const moves = this.legalMoves();
		if (moves.length === 0) throw new Error("no legal moves");
		return moves[Math.floor(Math.random() * moves.length)] ?? moves[0]!;
	}

	buildMovePrompt(): string {
		return movePrompt({
			side: this.sideName(),
			board: this.ascii(),
			fen: this.fen(),
		});
	}
}

/**
 * Pull a usable SAN out of a chatty LLM reply. Tries, in order: the whole
 * trimmed text (after stripping markdown fences), trailing lines, then any
 * token that looks like a chess move.
 */
export function extractSan(text: string): string {
	const candidates: string[] = [];
	const fenced = text.replace(/```[a-zA-Z]*\s*/g, "").trim();
	candidates.push(fenced);
	for (const line of fenced.split(/\r?\n/).map(l => l.trim()).filter(Boolean).reverse().slice(0, 3)) {
		candidates.push(line);
	}
	// Collect match tokens into a SEPARATE array — pushing into `candidates`
	// while for-of iterates it would grow the iterable forever.
	const ordered: string[] = [];
	const tokenRe = /[KQRBN]?[a-h][1-8](?:x[a-h][1-8])?(?:=[QRBN])?[+#]?|O-O(?:-O)?[+#]?/i;
	for (const candidate of candidates) {
		ordered.push(candidate);
		const match = tokenRe.exec(candidate);
		if (match) ordered.push(match[0]);
	}
	const seen = new Set<string>();
	for (const candidate of ordered) {
		if (seen.has(candidate)) continue;
		seen.add(candidate);
		if (/[a-h1-8O]/.test(candidate)) return candidate;
	}
	return text.trim();
}

/**
 * Try to land a reply on the board. Returns the applied move or an illegal-
 * move explanation; never throws.
 */
	export function tryApplyMove(game: ChessGame, san: string): MoveReply {
	try {
		const applied = game.applyMove(san);
		return { san: applied.san, text: san.trim(), illegal: false };
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		return { san, text: san.trim(), illegal: true, reason };
	}
}