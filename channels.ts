/** 一个 CPA 渠道；`root` 为服务根地址，不含 `/backend-api` 或 `/v1`。 */
export interface Channel {
	readonly name: string;
	readonly root: string;
	readonly key: string;
}

/** 一次建立通话失败后的处理：冷却并换下一个渠道、直接换下一个渠道，或停止并上报。 */
export type FailureVerdict = { kind: "cooldown"; seconds: number } | { kind: "next" } | { kind: "final" };

/** 429 响应既没有 `reset_seconds` 也没有 `Retry-After` 时使用的冷却时长。 */
export const DEFAULT_COOLDOWN_SECONDS = 60;

/** 接受 CPA 根地址或其 `/backend-api`、`/v1` 地址，返回根地址。 */
export function normalizeRoot(url: string): string {
	let root = url.trim().replace(/\/+$/, "");
	for (const suffix of ["/backend-api", "/v1"]) {
		if (root.endsWith(suffix)) root = root.slice(0, -suffix.length);
	}
	return root;
}

/**
 * 读取 429 的冷却秒数。CPA 把上游错误 JSON 转义后嵌在 `error` 字符串里，
 * 所以直接在原文中匹配 `reset_seconds`；没有时回退到 `Retry-After`。
 */
export function parseResetSeconds(body: string, retryAfter: string | null, now: number): number | undefined {
	const match = /reset_seconds\\*"\s*:\s*(\d+)/.exec(body);
	if (match) return Number(match[1]);
	if (!retryAfter) return undefined;
	const seconds = Number(retryAfter);
	if (Number.isFinite(seconds) && seconds >= 0) return seconds;
	const date = Date.parse(retryAfter);
	return Number.isNaN(date) ? undefined : Math.max(0, Math.ceil((date - now) / 1000));
}

/**
 * 429 表示该渠道额度耗尽，冷却后换渠道；5xx 视为渠道暂时故障，只换渠道不冷却；
 * 其他状态（401、400 等）是配置或请求问题，换渠道会掩盖它，直接上报。
 */
export function classifyFailure(status: number, body: string, retryAfter: string | null, now: number): FailureVerdict {
	if (status === 429) {
		return { kind: "cooldown", seconds: parseResetSeconds(body, retryAfter, now) ?? DEFAULT_COOLDOWN_SECONDS };
	}
	if (status >= 500) return { kind: "next" };
	return { kind: "final" };
}

/** 按配置顺序选择渠道，并记录各渠道的冷却截止时间（仅存于当前进程）。 */
export class ChannelRouter {
	readonly #channels: readonly Channel[];
	readonly #now: () => number;
	readonly #coolUntil = new Map<Channel, number>();

	constructor(channels: readonly Channel[], now: () => number = Date.now) {
		this.#channels = channels;
		this.#now = now;
	}

	/**
	 * 本次建立通话的尝试顺序：未冷却的渠道按配置顺序；冷却中的渠道不参与。
	 * 全部渠道都在冷却时，按恢复时间由早到晚全部尝试，而不是不试就失败。
	 */
	order(): Channel[] {
		const now = this.#now();
		const ready = this.#channels.filter(channel => (this.#coolUntil.get(channel) ?? 0) <= now);
		if (ready.length > 0) return ready;
		return [...this.#channels].sort((a, b) => (this.#coolUntil.get(a) ?? 0) - (this.#coolUntil.get(b) ?? 0));
	}

	cool(channel: Channel, seconds: number): void {
		this.#coolUntil.set(channel, this.#now() + seconds * 1000);
	}
}
