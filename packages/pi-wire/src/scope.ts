/**
 * 路径归属判定 —— 全仓**唯一一份**规则：一条路径落在哪个锚点 / 哪个已声明的 root 下。
 *
 * 词表 `agent | project | global` 是两端共用的：技能页（`SkillScopeRowDto.scope`）与
 * composer 的上下文条目（web-app 的 `ContextItem.scope`）问的是同一件事 —— 这个文件属于
 * Agent 自己的家 / 会话所在的 Project / 两者之外。两处说法必须一致，所以规则也只留一份：
 * serve 的 `server/skill-scope.ts` 与 web-app 都调这里的 `classifyScope`，没有人再实现第二遍。
 *
 * 判定顺序即优先级：agentDir 在 Project 里时（registry agent 的会话 cwd = agentDir）
 * 「属于这个 Agent」比「落在某个项目路径下」更具体，所以先判 agentDir。
 *
 * 路径包含判定由调用方传入（`contains`），本函数不自己写：归一能力是**运行时事实**不是规则 ——
 * serve 用 `@cornfield/utils` 的 pathIsWithin（realpath + 分隔符边界），浏览器做不到 realpath
 * （也绝不假装做到），只能做文本归一。规则只有一条，归一各按各的运行时的真实能力来。
 *
 * `pickDeepestRootIndex` 是同一族的第二条规则：一条路径落在**哪一个已声明的 root** 下
 * （最深祖先获胜）。输入契约同样是「已归一的字符串」，归一由调用方按自己运行时的真实能力做
 * （serve 的 `matchProjectForPath` 用 realpath 归一，web 的用量面板用词法归一）。
 */

/** 一条路径的归属范围：Agent 自己的家 / 会话所在的 Project / 两者之外（全局用户库等）。 */
export type Scope = "agent" | "project" | "global";

/** 判定依据：三个绝对路径锚点（调用方按 Agent / 会话 / Project 解析后传入）。 */
export interface ScopeAnchors {
	/** Agent 的物理 home。 */
	agentDir: string;
	/** 会话根（未 attach 的 agent：传 agentDir —— 它就是那个 agent 的会话根）。 */
	sessionCwd: string;
	/** 会话所属 Project 的 root（未归属 = 缺省，不是空串）。 */
	projectRoot?: string;
}

/** root 是否包含 candidate（含 root 自身）。各运行时按自己的归一能力实现。 */
export type PathContainment = (root: string, candidate: string) => boolean;

/** 一条绝对路径 + 锚点 → 范围。判定顺序即优先级（见文件头）。 */
export function classifyScope(filePath: string, anchors: ScopeAnchors, contains: PathContainment): Scope {
	if (contains(anchors.agentDir, filePath)) return "agent";
	if (anchors.projectRoot && contains(anchors.projectRoot, filePath)) return "project";
	if (contains(anchors.sessionCwd, filePath)) return "project";
	return "global";
}

/**
 * 路径分隔符字母表：调用方给的字符串可能是 `/`（posix、前端的词法归一）或 `\`（Windows serve
 * 的 realpath）。这不是归一化 —— 本函数不改写任何字符串，只决定「边界落在哪里」。
 */
function isSeparator(char: string | undefined): boolean {
	return char === "/" || char === "\\";
}

/** 去掉尾随分隔符；全是分隔符时保留一个（`/` 不能变成空串，它是根目录本身）。 */
function stripTrailingSeparators(root: string): string {
	let end = root.length;
	while (end > 1 && isSeparator(root[end - 1])) end -= 1;
	return end === root.length ? root : root.slice(0, end);
}

/** root 自身或 root 的后代（分隔符边界，两种分隔符都认）。 */
function isSelfOrDescendant(root: string, targetPath: string): boolean {
	if (targetPath === root) return true;
	if (!targetPath.startsWith(root)) return false;
	// 边界必须落在分隔符上（`/a/b` 不是 `/a/bc` 的祖先）；分隔符结尾的 root（`/`、`C:\`）
	// 在 root 长度处就已经是边界，不再要求 target 多一个分隔符。
	return isSeparator(targetPath[root.length]) || isSeparator(root[root.length - 1]);
}

/**
 * 命中 `targetPath` 的最深祖先 root 的下标；未命中 = -1。
 *
 * 这是「最深祖先获胜」规则的**唯一一份**实现：serve 的 `matchProjectForPath`（Project registry，
 * realpath 归一后）与 web 用量面板（词法归一后）都调它，谁都不许再写第二遍。
 *
 * 输入契约是**已归一化的路径字符串**：本函数不碰文件系统、不解析 symlink、不折叠分隔符、
 * 不改大小写 —— 归一能力是运行时事实（浏览器做不到 realpath），一律由调用方做完再进来。
 *
 * 边界语义：
 *   - 空串 root 跳过（前端词法归一可能产出空串：它不是任何路径的祖先）
 *   - `/a/b` 不是 `/a/bc` 的祖先（边界必须落在分隔符上）
 *   - 多个命中取最深者；同深并列（含同一 root 的两种写法）取声明在前的那一个，结果稳定
 *   - 尾随分隔符不参与判定（`/a/b/` ≡ `/a/b`）：前端词法归一常留尾斜杠，到这里必须等价
 *
 * `/` 与 `\` **都算分隔符**，这是有意的，不是漏了平台分支：serve 的归一（`resolveEquivalentPath`）
 * 在 Windows 上产出 `C:\a\b` 形式，只认 `/` 会让那里的「后代匹配」整体失效。代价写在明处 ——
 * POSIX 上文件名里真的含 `\` 时（例如 `/a/b\c`），它会被当成两段，从而可能把 `/a/b` 判成祖先。
 * 这是本规则的已知边界：换成按平台传分隔符，就得让浏览器知道 serve 跑在哪个平台，得不偿失。
 */
export function pickDeepestRootIndex(roots: readonly string[], targetPath: string): number {
	let best = -1;
	let bestDepth = -1;
	for (const [index, root] of roots.entries()) {
		if (!root) continue;
		const depth = stripTrailingSeparators(root);
		if (!isSelfOrDescendant(depth, targetPath)) continue;
		if (depth.length > bestDepth) {
			best = index;
			bestDepth = depth.length;
		}
	}
	return best;
}
