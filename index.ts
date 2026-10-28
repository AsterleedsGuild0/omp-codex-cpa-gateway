import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { type Channel, normalizeRoot } from "./channels";
import { installEndpointOverride } from "./endpoint";
import { installLiveRedirect } from "./live-redirect";

/** 读取 `CODEX_CPA_LIVE_<SLOT>_URL` / `_KEY`；两项须同时设置，只设一项视为配置错误并跳过。 */
function readChannel(pi: ExtensionAPI, slot: "PRIMARY" | "BACKUP"): Channel | undefined {
	const url = process.env[`CODEX_CPA_LIVE_${slot}_URL`]?.trim();
	const key = process.env[`CODEX_CPA_LIVE_${slot}_KEY`]?.trim();
	if (!url && !key) return undefined;
	if (!url || !key) {
		pi.logger.warn(`codex-cpa-gateway: CODEX_CPA_LIVE_${slot}_URL and _KEY must both be set; channel ignored`);
		return undefined;
	}
	return { name: slot.toLowerCase(), root: normalizeRoot(url), key };
}

export default function codexCpaGateway(pi: ExtensionAPI): void {
	const baseUrl = process.env.CODEX_CPA_BASE_URL?.trim();
	if (baseUrl) installEndpointOverride(pi, baseUrl);

	const primary = readChannel(pi, "PRIMARY");
	const backup = readChannel(pi, "BACKUP");
	if (!primary) {
		if (backup) pi.logger.warn("codex-cpa-gateway: CODEX_CPA_LIVE_BACKUP_* is set without a primary channel; /live redirect disabled");
		return;
	}
	installLiveRedirect(pi, backup ? [primary, backup] : [primary]);
}
