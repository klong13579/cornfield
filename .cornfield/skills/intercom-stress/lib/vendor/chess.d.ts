/**
 * Minimal type declarations for the vendored chess.js build.
 * Only the API surface used by this skill is declared.
 */

export type Color = "w" | "b";

export interface Piece {
	type: "p" | "n" | "b" | "r" | "q" | "k";
	color: Color;
	square?: string;
}

export interface MoveObject {
	color: Color;
	from: string;
	to: string;
	piece: string;
	captured?: string;
	promotion?: string;
	flags: string;
	san: string;
	lan: string;
	before: string;
	after: string;
}

export class Chess {
	constructor(fen?: string, options?: { skipValidation?: boolean });
	load(fen: string, options?: { skipValidation?: boolean; preserveHeaders?: boolean }): void;
	fen(): string;
	reset(): void;
	turn(): Color;
	board(): Array<Array<Piece | null>>;
	ascii(): string;
	findPiece(square: string, type?: string): Piece | null;
	put(piece: Piece, square: string): void;
	remove(square: string): string | undefined;
	move(move: string | { from: string; to: string; promotion?: string }, options?: { strict?: boolean }): MoveObject | null;
	moves(options?: { verbose?: boolean; square?: string; piece?: string }): string[] | MoveObject[];
	history(options?: { verbose?: boolean }): string[] | MoveObject[];
	undo(): MoveObject | null;
	inCheck(): boolean;
	isCheck(): boolean;
	isCheckmate(): boolean;
	isStalemate(): boolean;
	isInsufficientMaterial(): boolean;
	isThreefoldRepetition(): boolean;
	isDraw(): boolean;
	isGameOver(): boolean;
	getComment(): string | undefined;
}