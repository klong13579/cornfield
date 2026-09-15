/**
 * Protocol handler for skill:// URLs.
 *
 * Resolves skill names to their SKILL.md files or relative paths within skill directories.
 *
 * URL forms:
 * - skill://<name> - Reads SKILL.md
 * - skill://<name>/ - Reads the skill directory as a dirent listing
 * - skill://<name>/<path> - Reads relative path within skill's baseDir
 */
import type { Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@cornfield/utils";
import type { Skill } from "../extensibility/skills";
import type { InternalResource, InternalUrl, ProtocolHandler } from "./types";

export interface SkillProtocolOptions {
	/**
	 * Returns the currently loaded skills.
	 */
	getSkills: () => readonly Skill[];
}

/**
 * Get content type based on file extension.
 */
function getContentType(filePath: string): InternalResource["contentType"] {
	const ext = path.extname(filePath).toLowerCase();
	if (ext === ".md") return "text/markdown";
	return "text/plain";
}

/**
 * Validate that a path is safe (no traversal, no absolute paths).
 */
export function validateRelativePath(relativePath: string): void {
	if (path.isAbsolute(relativePath)) {
		throw new Error("Absolute paths are not allowed in skill:// URLs");
	}

	const normalized = path.normalize(relativePath);
	if (normalized.startsWith("..") || normalized.includes("/../") || normalized.includes("/..")) {
		throw new Error("Path traversal (..) is not allowed in skill:// URLs");
	}
}

/**
 * Handler for skill:// URLs.
 *
 * Resolves skill names to their content files.
 */
export class SkillProtocolHandler implements ProtocolHandler {
	readonly scheme = "skill";
	readonly immutable = true;

	constructor(private readonly options: SkillProtocolOptions) {}

	async resolve(url: InternalUrl): Promise<InternalResource> {
		const skills = this.options.getSkills();

		// Extract skill name from host
		const skillName = url.rawHost || url.hostname;
		if (!skillName) {
			throw new Error("skill:// URL requires a skill name: skill://<name>");
		}

		// Find the skill
		const skill = skills.find(s => s.name === skillName);
		if (!skill) {
			const available = skills.map(s => s.name);
			const availableStr = available.length > 0 ? available.join(", ") : "none";
			throw new Error(`Unknown skill: ${skillName}\nAvailable: ${availableStr}`);
		}

		// Determine the file to read
		let targetPath: string;
		const urlPath = url.pathname;
		const hasRelativePath = urlPath && urlPath !== "/" && urlPath !== "";

		if (hasRelativePath) {
			// Read relative path within skill's baseDir
			const relativePath = decodeURIComponent(urlPath.slice(1)); // Remove leading /
			validateRelativePath(relativePath);
			targetPath = path.join(skill.baseDir, relativePath);

			// Verify the resolved path is still within baseDir
			const resolvedPath = path.resolve(targetPath);
			const resolvedBaseDir = path.resolve(skill.baseDir);
			if (!resolvedPath.startsWith(resolvedBaseDir + path.sep) && resolvedPath !== resolvedBaseDir) {
				throw new Error("Path traversal is not allowed");
			}
		} else if (urlPath === "/") {
			// A trailing slash addresses the skill root itself, so the caller can
			// discover the skill's files instead of only its SKILL.md.
			targetPath = skill.baseDir;
		} else {
			// Read SKILL.md
			targetPath = skill.filePath;
		}

		// Stat first: a directory has no text body, and Bun.file(dir).text() throws EISDIR.
		let stats: Stats;
		try {
			stats = await fs.stat(targetPath);
		} catch (error) {
			if (isEnoent(error)) {
				throw new Error(`File not found: ${targetPath}`);
			}
			throw error;
		}

		if (stats.isDirectory()) {
			return {
				url: url.href,
				content: "",
				contentType: "text/plain",
				sourcePath: targetPath,
				isDirectory: true,
				notes: [],
			};
		}
		if (!stats.isFile()) {
			throw new Error(`skill:// URL must resolve to a file or directory: ${url.href}`);
		}

		const content = await Bun.file(targetPath).text();
		const contentType = getContentType(targetPath);

		return {
			url: url.href,
			content,
			contentType,
			size: Buffer.byteLength(content, "utf-8"),
			sourcePath: targetPath,
			notes: [],
		};
	}
}
