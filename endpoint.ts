import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";

const PROVIDER = "openai-codex";

/**
 * 会话启动时把 `openai-codex` 的地址覆盖为 `baseUrl`，只改运行时注册，
 * 不写回 models.yml，也不碰模型定义和认证。
 */
export function installEndpointOverride(pi: ExtensionAPI, baseUrl: string): void {
	pi.on("session_start", async (_event, ctx) => {
		pi.registerProvider(PROVIDER, { baseUrl });

		// 当前模型可能在覆盖前已选定，须重新绑定才能让首个请求使用新地址。
		const current = ctx.model;
		if (current?.provider !== PROVIDER) return;
		const updated = ctx.modelRegistry.find(current.provider, current.id);
		if (!updated) throw new Error(`codex-cpa-gateway: current model ${current.id} not found after endpoint override`);
		await pi.setModel(updated);
	});
}
