import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { type Channel, ChannelRouter, classifyFailure } from "./channels";

/*
 * OMP 的 /live 把地址和认证写死为官方 Codex：先向 openai-codex 取 OAuth，
 * 再 POST 建立通话、用返回的通话 ID 连事件通道。这里在进程内改写这两个请求，
 * 让它们改走 CPA 的 /v1/live 与 /v1/live/{callId}，并用 CPA Key 认证。
 * 依赖 OMP 内部实现（18.13.2 验证）：OMP 升级后若失效，表现为 /live 报错。
 */

const PROVIDER = "openai-codex";
const SIGNALING_PREFIX = "https://chatgpt.com/backend-api/codex/realtime/calls";
const SIDEBAND_PREFIX = "wss://api.openai.com/v1/live/";
const OFFICIAL_HOSTS: Record<string, true> = { "chatgpt.com": true, "api.openai.com": true };
/** 让 OMP 通过 OAuth 检查的占位凭据；只出现在被改写的请求里，从不发往官方。 */
const SENTINEL = "codex-cpa-gateway-live";
const CALL_ID_PATTERN = /^rtc_[\w-]+$/;
const MAX_TRACKED_CALLS = 32;
const INSTALLED = Symbol.for("codex-cpa-gateway.live-redirect");

type Logger = ExtensionAPI["logger"];
type FetchInit = RequestInit & { proxy?: string };

function requestHeaders(input: RequestInfo | URL, init: FetchInit | undefined): Headers {
	return new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
}

function parseCallId(location: string | null): string | undefined {
	return location
		?.split("?", 1)[0]
		?.split("/")
		.find(segment => CALL_ID_PATTERN.test(segment));
}

/** 读过响应体后重建响应；去掉已不再成立的编码与长度头。 */
function rebuildResponse(response: Response, body: string): Response {
	const headers = new Headers(response.headers);
	headers.delete("content-encoding");
	headers.delete("content-length");
	return new Response(body, { status: response.status, statusText: response.statusText, headers });
}

class LiveRedirect {
	readonly #router: ChannelRouter;
	readonly #logger: Logger;
	readonly #fetch: typeof fetch;
	/** 通话 ID 只存在于发出它的 CPA，事件通道必须连回同一渠道。 */
	readonly #calls = new Map<string, Channel>();

	constructor(channels: readonly Channel[], logger: Logger, originalFetch: typeof fetch) {
		this.#router = new ChannelRouter(channels);
		this.#logger = logger;
		this.#fetch = originalFetch;
	}

	async fetch(input: RequestInfo | URL, init?: FetchInit): Promise<Response> {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		if (url.startsWith(SIGNALING_PREFIX)) return this.#signal(input, init);
		if (this.#carriesSentinel(url, input, init)) {
			// 其他调用方拿到占位凭据时，在本地拒绝，不把它发往官方。
			return Response.json({ error: "codex-cpa-gateway: OAuth is not available for this request" }, { status: 401 });
		}
		return this.#fetch(input, init);
	}

	sidebandTarget(url: string, options: { headers?: Record<string, string> } | undefined): [string, unknown] | undefined {
		if (!url.startsWith(SIDEBAND_PREFIX)) return undefined;
		const callId = url.slice(SIDEBAND_PREFIX.length).split(/[/?]/, 1)[0];
		const channel = callId ? this.#calls.get(callId) : undefined;
		if (!channel || !callId) return undefined;
		const target = `${channel.root.replace(/^http/, "ws")}/v1/live/${callId}`;
		const { proxy: _proxy, ...rest } = (options ?? {}) as Record<string, unknown>;
		return [target, { ...rest, headers: { ...options?.headers, Authorization: `Bearer ${channel.key}` } }];
	}

	#carriesSentinel(url: string, input: RequestInfo | URL, init: FetchInit | undefined): boolean {
		let host: string;
		try {
			host = new URL(url).hostname;
		} catch {
			return false;
		}
		return OFFICIAL_HOSTS[host] === true && requestHeaders(input, init).get("authorization") === `Bearer ${SENTINEL}`;
	}

	async #signal(input: RequestInfo | URL, init: FetchInit | undefined): Promise<Response> {
		let lastResponse: Response | undefined;
		let lastError: unknown;
		for (const channel of this.#router.order()) {
			const headers = requestHeaders(input, init);
			headers.set("Authorization", `Bearer ${channel.key}`);
			const { proxy: _proxy, ...rest } = init ?? {};
			let response: Response;
			try {
				response = await this.#fetch(`${channel.root}/v1/live`, { ...rest, headers });
			} catch (error) {
				if (init?.signal?.aborted) throw error;
				this.#logger.warn("codex-cpa-gateway: live channel unreachable", { channel: channel.name, error: String(error) });
				lastResponse = undefined;
				lastError = error;
				continue;
			}
			if (response.ok) {
				this.#track(parseCallId(response.headers.get("location")), channel);
				this.#logger.debug("codex-cpa-gateway: live call opened", { channel: channel.name });
				return response;
			}

			const body = await response.text();
			lastResponse = rebuildResponse(response, body);
			const verdict = classifyFailure(response.status, body, response.headers.get("retry-after"), Date.now());
			if (verdict.kind === "final") return lastResponse;
			if (verdict.kind === "cooldown") this.#router.cool(channel, verdict.seconds);
			this.#logger.warn("codex-cpa-gateway: live channel failed, trying next", {
				channel: channel.name,
				status: response.status,
				cooldownSeconds: verdict.kind === "cooldown" ? verdict.seconds : undefined,
			});
		}
		if (lastResponse) return lastResponse;
		throw lastError ?? new Error("codex-cpa-gateway: no live channel configured");
	}

	#track(callId: string | undefined, channel: Channel): void {
		if (!callId) return;
		this.#calls.set(callId, channel);
		while (this.#calls.size > MAX_TRACKED_CALLS) {
			const oldest = this.#calls.keys().next().value;
			if (oldest === undefined) break;
			this.#calls.delete(oldest);
		}
	}
}

interface OAuthAccessSurface {
	access(provider: string, ...rest: unknown[]): Promise<unknown>;
}

const patchedOAuth = new WeakSet<object>();

/** OMP 拿不到 openai-codex 的 OAuth 时（例如 models.yml 配了 API Key），返回占位凭据放行 /live。 */
function patchOAuthAccess(oauth: OAuthAccessSurface): void {
	if (patchedOAuth.has(oauth)) return;
	patchedOAuth.add(oauth);
	const access = oauth.access.bind(oauth);
	oauth.access = async (provider, ...rest) => {
		const real = await access(provider, ...rest);
		if (real || provider !== PROVIDER) return real;
		return { accessToken: SENTINEL };
	};
}

/** 安装 /live 转接。全局 fetch、WebSocket 每个进程只改写一次；子会话复用同一实例。 */
export function installLiveRedirect(pi: ExtensionAPI, channels: readonly Channel[]): void {
	const registry = globalThis as typeof globalThis & { [INSTALLED]?: LiveRedirect };
	if (!registry[INSTALLED]) {
		const redirect = new LiveRedirect(channels, pi.logger, globalThis.fetch);
		registry[INSTALLED] = redirect;
		globalThis.fetch = Object.assign((input: RequestInfo | URL, init?: FetchInit) => redirect.fetch(input, init), {
			preconnect: globalThis.fetch.preconnect,
		});
		globalThis.WebSocket = new Proxy(globalThis.WebSocket, {
			construct(target, args, newTarget) {
				const [url, options] = args as [string | URL, { headers?: Record<string, string> } | undefined];
				const rewritten = redirect.sidebandTarget(String(url), options);
				return Reflect.construct(target, rewritten ?? args, newTarget);
			},
		});
	}

	pi.on("session_start", async (_event, ctx) => {
		patchOAuthAccess(ctx.modelRegistry.authStorage.oauth as unknown as OAuthAccessSurface);
	});
}
