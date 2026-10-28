import { describe, expect, test } from "bun:test";
import { ChannelRouter, classifyFailure, DEFAULT_COOLDOWN_SECONDS, normalizeRoot, parseResetSeconds } from "./channels";

// 本机 CPA 8.0.44 在号池冷却时返回的实际响应体（截短）。
const CPA_COOLDOWN_BODY =
	'{"error":"{\\"error\\":{\\"code\\":\\"model_cooldown\\",\\"provider\\":\\"codex\\",\\"reset_seconds\\":3878,\\"reset_time\\":\\"1h4m38s\\"}}"}';

describe("normalizeRoot", () => {
	test("strips the gateway path suffixes users already have in their base URLs", () => {
		expect(normalizeRoot("http://localhost:8317/backend-api")).toBe("http://localhost:8317");
		expect(normalizeRoot("https://cpa.example.org/v1/")).toBe("https://cpa.example.org");
		expect(normalizeRoot(" https://cpa.example.org ")).toBe("https://cpa.example.org");
	});
});

describe("parseResetSeconds", () => {
	test("reads reset_seconds from CPA's escaped upstream error", () => {
		expect(parseResetSeconds(CPA_COOLDOWN_BODY, null, 0)).toBe(3878);
	});

	test("prefers the body over Retry-After", () => {
		expect(parseResetSeconds(CPA_COOLDOWN_BODY, "5", 0)).toBe(3878);
	});

	test("falls back to Retry-After seconds and HTTP dates", () => {
		expect(parseResetSeconds("{}", "120", 0)).toBe(120);
		const now = Date.parse("2026-10-28T12:00:00Z");
		expect(parseResetSeconds("{}", "Wed, 28 Oct 2026 12:01:30 GMT", now)).toBe(90);
	});

	test("returns undefined when neither source states a duration", () => {
		expect(parseResetSeconds("{}", null, 0)).toBeUndefined();
		expect(parseResetSeconds("{}", "soon", 0)).toBeUndefined();
	});
});

describe("classifyFailure", () => {
	test("429 cools the channel for the advertised duration", () => {
		expect(classifyFailure(429, CPA_COOLDOWN_BODY, null, 0)).toEqual({ kind: "cooldown", seconds: 3878 });
	});

	test("429 without a duration uses the default cooldown", () => {
		expect(classifyFailure(429, "{}", null, 0)).toEqual({ kind: "cooldown", seconds: DEFAULT_COOLDOWN_SECONDS });
	});

	test("5xx moves on without cooling", () => {
		expect(classifyFailure(502, "", null, 0)).toEqual({ kind: "next" });
	});

	test("auth and request errors stop instead of hiding behind the backup", () => {
		expect(classifyFailure(401, "", null, 0)).toEqual({ kind: "final" });
		expect(classifyFailure(400, "", null, 0)).toEqual({ kind: "final" });
	});
});

describe("ChannelRouter", () => {
	const primary = { name: "primary", root: "http://primary", key: "a" };
	const backup = { name: "backup", root: "http://backup", key: "b" };

	test("skips a cooling primary and returns to it once the cooldown expires", () => {
		let now = 0;
		const router = new ChannelRouter([primary, backup], () => now);
		expect(router.order()).toEqual([primary, backup]);

		router.cool(primary, 60);
		now = 59_999;
		expect(router.order()).toEqual([backup]);

		now = 60_000;
		expect(router.order()).toEqual([primary, backup]);
	});

	test("tries every channel, soonest recovery first, when all are cooling", () => {
		const now = 0;
		const router = new ChannelRouter([primary, backup], () => now);
		router.cool(primary, 300);
		router.cool(backup, 30);
		expect(router.order()).toEqual([backup, primary]);
	});
});
