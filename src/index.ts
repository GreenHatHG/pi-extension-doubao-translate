/**
 * doubao-translate — auto-translate assistant replies via doubao_hook.
 *
 * - Only the final prose reply is translated: the LAST text block of an
 *   assistant message with no tool calls. Thinking blocks, tool calls and
 *   mid-turn progress text are never sent to doubao.
 * - /zh toggles display: off = original only, on = original + Chinese below.
 *   State persists across sessions and machines via ~/.pi/agent/cache/.
 * - Fenced code blocks are kept out of translation and stitched back untouched.
 * - Transport: HTTP POST to doubao_server.js (/translate). Two ways it finds it:
 *     1. a unix-socket tunnel from tssh-vps.sh (/tmp/doubao-http-*), used on VPS
 *     2. direct TCP to 127.0.0.1:8765, used on the Mac where the server runs
 *       under launchd (com.jooooody.doubao-server: keepalive + autostart).
 * - Failure is silent when /zh is off; when on, only the LATEST failed reply
 *   carries an inline notice — scrolling history never replays old warnings.
 *
 * Refresh trick: pi re-renders assistant messages when setHiddenThinkingLabel is
 * called (it walks every AssistantMessageComponent and rebuilds content, which
 * re-runs markdown transformers). We call it with the default label to pick up
 * new translations / toggles. If you rely on a custom hidden-thinking label,
 * this extension will reset it to "Thinking..." on each refresh.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import * as http from "node:http";

const MIN_LENGTH = 12;
const BACKFILL_LIMIT = 20;
const STATE_FILE = `${process.env.HOME ?? ""}/.pi/agent/cache/doubao-translate-state.json`;
const DOUBAO_PORT = 8765;
// tssh-vps.sh forwards the Mac's doubao server to a fresh unix socket per
// connection (/tmp/<TUNNEL_PREFIX><pid>-<rand>). Newest-first: an old dead
// file must never win; a connect failure falls back to TCP in translateProse.
const TUNNEL_PREFIX = "doubao-http-"; // bare filenames in /tmp, not absolute paths
// After a failed translation, poll /health (local-only reply, no model call)
// every 5s until the tunnel is back, then retry the text ONCE. If that retry
// fails too, give up — no further polling. Deadline is just a safety cap.
const HEALTH_POLL_MS = 5_000;
const HEALTH_TIMEOUT_MS = 3_000; // a black-holed tunnel must not hang the loop
const RETRY_GIVEUP_MS = 60 * 60_000;

// Footer status shown while a translation is in flight. Key must be unique
// per extension so other setStatus callers don't collide.
const STATUS_KEY = "doubao-zh";
const STATUS_LINGER_MS = 3_000; // how long ✓/✗ stays in the footer before clearing

function loadShowZh(): boolean {
	try {
		const raw = JSON.parse(readFileSync(STATE_FILE, "utf8")) as { showZh?: boolean };
		return raw.showZh === true;
	} catch {
		return false;
	}
}

function saveShowZh(showZh: boolean): void {
	try {
		mkdirSync(dirname(STATE_FILE), { recursive: true });
		writeFileSync(STATE_FILE, JSON.stringify({ showZh }));
	} catch {
		// state just won't persist
	}
}

// Newest-first tunnel candidates; a connect probe in translateProse settles
// Newest-first tunnel socket candidates. Dead sockets left behind by old
// tunnels can still be newest by mtime, so callers must probe-connect them
// in order and only fall back to TCP after every candidate fails.
function findTunnelSockets(): string[] {
	try {
		return readdirSync("/tmp")
			.filter((f) => f.startsWith(TUNNEL_PREFIX))
			.map((f) => `/tmp/${f}`)
			.filter((p) => {
				try {
					return statSync(p).isSocket();
				} catch {
					return false;
				}
			})
			.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
	} catch {
		return [];
	}
}

// One HTTP POST to the doubao server. Probes tunnel sockets newest-first
// (VPS), falling back to direct TCP 127.0.0.1:8765 (Mac) only after every
// socket candidate fails to connect. Each call re-scans /tmp, so a fresh
// socket from a new tunnel is picked up immediately — nothing is cached.
// Never rejects.
function translateProse(prose: string): Promise<string | null> {
	return new Promise((resolve) => {
		const body = JSON.stringify({ text: prose, to: "zh" });
		let settled = false;
		const done = (t: string | null) => {
			if (!settled) {
				settled = true;
				resolve(t);
			}
		};
		const timer = setTimeout(() => done(null), 120_000);
		const candidates = findTunnelSockets();

		const request = (opts: http.RequestOptions, socketIdx: number) => {
			const req = http.request(opts, (res) => {
				let out = "";
				res.on("data", (d: Buffer) => (out += d));
				res.on("end", () => {
					clearTimeout(timer);
					try {
						const data = JSON.parse(out) as { ok?: boolean; translation?: string };
						done(data.ok && data.translation ? data.translation.trim() : null);
					} catch {
						done(null);
					}
				});
			});
			req.on("error", () => {
				// next dead socket candidate, then TCP; TCP miss gives up
				if (socketIdx < candidates.length - 1) {
					request({ ...opts, socketPath: candidates[socketIdx + 1] }, socketIdx + 1);
				} else if (opts.socketPath) {
					opts.socketPath = undefined;
					opts.host = "127.0.0.1";
					opts.port = DOUBAO_PORT;
					request(opts, candidates.length);
				} else {
					clearTimeout(timer);
					done(null);
				}
			});
			req.end(body);
		};

		request(
			{
				socketPath: candidates[0],
				host: candidates[0] ? undefined : "127.0.0.1",
				port: candidates[0] ? undefined : DOUBAO_PORT,
				path: "/translate",
				method: "POST",
				headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
			},
			0,
		);
	});
}

// GET /health through the same transport translateProse uses: probe all
// tunnel sockets newest-first, TCP fallback. Each call re-scans /tmp.
// The reply is served from server state — no doubao model call — so polling
// it is free. 3s timeout: a black-holed tunnel must not hang the loop.
function healthCheck(): Promise<boolean> {
	return new Promise((resolve) => {
		let settled = false;
		const done = (ok: boolean) => {
			if (!settled) {
				settled = true;
				resolve(ok);
			}
		};
		const timer = setTimeout(() => done(false), HEALTH_TIMEOUT_MS);
		const candidates = findTunnelSockets();

		const request = (opts: http.RequestOptions, socketIdx: number) => {
			const req = http.request(opts, (res) => {
				let out = "";
				res.on("data", (d: Buffer) => (out += d));
				res.on("end", () => {
					clearTimeout(timer);
					try {
						done((JSON.parse(out) as { ok?: boolean }).ok === true);
					} catch {
						done(false);
					}
				});
			});
			req.on("error", () => {
				if (socketIdx < candidates.length - 1) {
					request({ ...opts, socketPath: candidates[socketIdx + 1] }, socketIdx + 1);
				} else if (opts.socketPath) {
					opts.socketPath = undefined;
					opts.host = "127.0.0.1";
					opts.port = DOUBAO_PORT;
					request(opts, candidates.length);
				} else {
					clearTimeout(timer);
					done(false);
				}
			});
			req.end();
		};

		request(
			{
				socketPath: candidates[0],
				host: candidates[0] ? undefined : "127.0.0.1",
				port: candidates[0] ? undefined : DOUBAO_PORT,
				path: "/health",
				method: "GET",
				headers: { "content-length": 0 },
			},
			0,
		);
	});
}

export default function (pi: ExtensionAPI) {
	let showZh = loadShowZh();
	const translations = new Map<string, string>();
	const pending = new Set<string>();

	// Replace fenced code blocks with placeholders so doubao never sees code.
	// Prose between fences is further split into paragraphs (blank-line
	// separated) so each one becomes its own segment for bilingual interleaving.
	function splitCode(text: string): { parts: string[]; blocks: string[] } {
		const rawParts: string[] = [];
		const blocks: string[] = [];
		const re = /```[\s\S]*?```/g;
		let last = 0;
		let m: RegExpExecArray | null;
		while ((m = re.exec(text)) !== null) {
			if (m.index > last) rawParts.push(text.slice(last, m.index));
			blocks.push(m[0]);
			last = m.index + m[0].length;
		}
		if (last < text.length) rawParts.push(text.slice(last));
		// Split each prose chunk into paragraphs, remembering separators so the
		// rebuild can reassemble them.
		const parts: string[] = [];
		const separators: Array<string[]> = []; // trailing separators after parts[i-1]
		for (const raw of rawParts) {
			const paras = raw.split(/\n\s*\n/);
			separators.push([]);
			paras.forEach((p, i) => {
				if (i > 0) separators[separators.length - 1].push("\n\n");
				parts.push(p);
			});
		}
		// Re-expand separators into the parts array: each part keeps its own
		// leading/trailing text, paragraphs joined by \n\n in rebuild.
		return { parts, blocks };
	}

	// Rebuild text from parts and blocks, walking the original fence structure.
	function reassemble(text: string, blocks: string[], byPart: Map<number, string>): string {
		let out = "";
		let partIdx = 0;
		let blockIdx = 0;
		const re = /```[\s\S]*?```/g;
		let last = 0;
		let m: RegExpExecArray | null;
		const emitProse = (prose: string) => {
			const paras = prose.split(/\n\s*\n/);
			paras.forEach((p, i) => {
				if (i > 0) out += "\n\n";
				out += p;
				const t = byPart.get(partIdx++);
				if (t) out += `\n\n${quotePrefix(t)}`;
			});
		};
		while ((m = re.exec(text)) !== null) {
			if (m.index > last) emitProse(text.slice(last, m.index));
			out += blocks[blockIdx++] ?? m[0];
			last = m.index + m[0].length;
		}
		if (last < text.length) emitProse(text.slice(last));
		return out;
	}

	function mostlyCJK(text: string): boolean {
		const cjk = (text.match(/\u4e00-\u9fff/g) ?? []).length;
		if (cjk > text.replace(/\s/g, "").length * 0.3) return true;
		// ASCII-diluted Chinese (dense paths / package names / identifiers) can
		// drop the ratio below 0.3. A natural Chinese sentence always contains a
		// long run of consecutive CJK chars; English prose mentioning the odd
		// Chinese term does not, so a run of >= 8 chars means "already Chinese".
		return /[\u4e00-\u9fff]{8,}/.test(text);
	}

	// Run at most 5 in-flight requests; the server queues beyond that anyway,
	// but staying under its own limit keeps its logs honest.
	const semaphore = (() => {
		let active = 0;
		const queue: Array<() => void> = [];
		return function run<T>(fn: () => Promise<T>): Promise<T> {
			return new Promise<T>((resolve) => {
				const start = () => {
					active++;
					fn().then((v) => {
						active--;
						queue.shift()?.();
						resolve(v);
					});
				};
				active < 5 ? start() : queue.push(start);
			});
		};
	})();

	// Markers like 【1】 survive Chinese translation, so we join all prose chunks
	// into ONE request and split the reply back on them. One reply = 1 request.
	const MARKER_RE = /【(\d+)】/g;

	function buildRequest(parts: string[], idxs: number[]): { body: string | null; markers: number[] } {
		if (idxs.length === 0) return { body: null, markers: [] };
		if (idxs.length === 1) return { body: parts[idxs[0]], markers: [idxs[0]] };
		const markers = idxs.slice();
		const body = markers.map((partIdx, i) => `【${i + 1}】${parts[partIdx]}`).join("\n\n");
		return { body, markers };
	}

	// One part failed to come back from doubao. Italic + parens so it can't be
	// mistaken for translation prose (same style as the notify fallback).
	const missingNotice = (n: number) => `*(translation unavailable: segment ${n} missing from response)*`;

	// Split doubao's reply on 【n】 markers. Unmatched segments keep their slot
	// but show the notice instead of a bogus translation. No retry.
	function splitTranslation(reply: string, markerCount: number): string[] | null {
		const segs = new Map<number, string>();
		let lastN = 0;
		let lastIdx = 0;
		let m: RegExpExecArray | null;
		MARKER_RE.lastIndex = 0;
		while ((m = MARKER_RE.exec(reply)) !== null) {
			if (lastN > 0) segs.set(lastN, reply.slice(lastIdx, m.index).trim());
			lastN = Number(m[1]);
			lastIdx = m.index + m[0].length;
		}
		if (lastN > 0) segs.set(lastN, reply.slice(lastIdx).trim());
		if (segs.size === 0) return null;
		const out: string[] = [];
		for (let n = 1; n <= markerCount; n++) out.push(segs.get(n) || missingNotice(n));
		return out;
	}

	// One request for the whole reply: numbered prose chunks in, split back out.
	// force (manual /translate): send every non-empty part — no length/CJK
	// gate, and an identical-output result is still shown, not dropped.
	async function translateText(text: string, force = false): Promise<string | null> {
		const { parts, blocks } = splitCode(text);
		const idxs: number[] = [];
		parts.forEach((p, i) => {
			const core = p.trim();
			if (core.length === 0) return;
			if (force || (core.length >= MIN_LENGTH && !mostlyCJK(core))) idxs.push(i);
		});
		if (idxs.length === 0) return null;
		const { body, markers } = buildRequest(parts, idxs);
		if (!body) return null;
		const reply = await semaphore(() => translateProse(body));
		if (!reply) return null;
		let translated: string[];
		if (markers.length === 1) {
			translated = [reply];
		} else {
			const segs = splitTranslation(reply, markers.length);
			if (!segs) return null; // markers lost entirely: show original, no retry
			translated = segs;
		}
		// Map marker slots back onto part indexes; dropped segments get retried.
		const byPart = new Map<number, string>();
		const missing: Array<{ slot: number; partIdx: number; text: string }> = [];
		markers.forEach((partIdx, slot) => {
			const t = translated[slot];
			if (t && !t.startsWith("*(translation unavailable")) byPart.set(partIdx, t);
			else missing.push({ slot, partIdx, text: parts[partIdx].trim() });
		});
		if (missing.length > 0) {
			const filled = await fillMissing(missing);
			for (const [partIdx, t] of filled) byPart.set(partIdx, t);
		}
		const out = reassemble(text, blocks, byPart);
		if (!force && out.trim() === text.trim()) return null;
		return out;
	}

	// Doubao sometimes drops or merges a 【n】 marker. Retry those segments one by
	// one (no marker needed for a single paragraph), then give up per segment.
	async function fillMissing(
	missing: Array<{ slot: number; partIdx: number; text: string }>,
): Promise<Map<number, string>> {
	const filled = new Map<number, string>();
	await Promise.all(
		missing.map(async ({ slot, partIdx, text }) => {
			const t = await semaphore(() => translateProse(text));
			if (t) filled.set(partIdx, t);
			else filled.set(partIdx, missingNotice(slot + 1));
		}),
	);
	return filled;
}

	// Only the newest failed reply shows the inline notice; older failures
	// keep plain original text. Cleared when that text translates.
	let lastFailedKey: string | null = null;
	let polling = false;

	// After a failed translation: poll /health (free, no model call) every 5s
	// until the tunnel answers, then retry the newest failed text ONCE. If that
	// retry fails too, stop polling — a manual /translate is the only way back.
	// Deadline is just a safety cap on the health wait.
	function startHealthPoll(ctx: Parameters<typeof requestTranslate>[1]) {
		if (polling) return;
		polling = true;
		const deadline = Date.now() + RETRY_GIVEUP_MS;
		const tick = async () => {
			if (!polling) return;
			if (await healthCheck()) {
				polling = false;
				const key = lastFailedKey;
				if (!key) return;
				// fromRetry=true: a failed retry must not re-arm polling, or it
				// would retry forever — one auto retry, then wait for /translate.
				forceTranslate(key, ctx, true);
				return;
			}
			if (Date.now() >= deadline) {
				polling = false;
				try {
					ctx.ui.notify("(translation: tunnel still down after 1h, gave up retrying)", "warning");
				} catch {
					// non-TUI mode
				}
				return;
			}
			setTimeout(tick, HEALTH_POLL_MS);
		};
		setTimeout(tick, HEALTH_POLL_MS);
	}

	// Manual trigger must bypass EVERY gate — length, mostlyCJK, dedupe — so
	// /translate always sends and a retry actually re-sends the request.
	function forceTranslate(
		text: string,
		ctx: Parameters<typeof requestTranslate>[1],
		fromRetry = false,
	): void {
		const key = text.trim();
		pending.delete(key);
		translations.delete(key);
		requestTranslate(key, ctx, true, fromRetry, true);
	}

	// notifyDone: manual triggers report back when the request settles; the
	// auto path stays silent.
	function requestTranslate(
		text: string,
		ctx: {
			ui: {
				setHiddenThinkingLabel: (l?: string) => void;
				notify: (message: string, type?: "info" | "warning" | "error") => void;
				setStatus?: (key: string, text?: string) => void;
			};
		},
		notifyDone = false,
		fromRetry = false,
		force = false,
	) {
		const key = text.trim();
		if (!force) {
			if (translations.has(key) || pending.has(key)) return;
			if (key.length < MIN_LENGTH) return;
			if (mostlyCJK(key)) return;
		}
		pending.add(key);
		// Footer status: show while the request is in flight. setStatus may be
		// absent in older pi builds; degrade to silent.
		const setStatus = ctx.ui.setStatus?.bind(ctx.ui);
		const clearStatus = () => setStatus?.(STATUS_KEY, undefined);
		const showStatus = (s: string) => setStatus?.(STATUS_KEY, s);
		showStatus("⏳ 翻译中…");
		void translateText(key, force).then((t) => {
			pending.delete(key);
			if (t) {
				translations.set(key, t);
				if (lastFailedKey === key) lastFailedKey = null; // notice goes away
				showStatus("✓ 已翻译");
				setTimeout(clearStatus, STATUS_LINGER_MS);
				refresh(ctx);
				if (notifyDone) ctx.ui.notify("Translation updated", "info");
			} else {
				lastFailedKey = key;
				showStatus("✗ 翻译不可用");
				setTimeout(clearStatus, STATUS_LINGER_MS);
				refresh(ctx);
				// Inline notice (transformer) is the single failure signal — no
				// toast here. A failed health-poll retry (fromRetry) must not
				// re-arm polling, or it would retry forever.
				if (!fromRetry) startHealthPoll(ctx);
			}
		});
	}

	// Force all assistant message components to rebuild (re-running transformers).
	function refresh(ctx: { ui: { setHiddenThinkingLabel: (l?: string) => void } }) {
		try {
			ctx.ui.setHiddenThinkingLabel("Thinking...");
		} catch {
			// non-TUI mode; nothing to refresh
		}
	}

	// Last text block of a tool-call-free assistant message = the final prose reply.
	function lastTextOf(message: {
		content?: Array<{ type: string; text?: string }>;
	}): string | undefined {
		if (!Array.isArray(message.content) || message.content.some((c) => c.type === "toolCall")) return undefined;
		for (let i = message.content.length - 1; i >= 0; i--) {
			const c = message.content[i];
			if (c.type === "text" && c.text?.trim()) return c.text;
		}
		return undefined;
	}

	pi.on("message_end", async (event, ctx) => {
		if (event.message.role !== "assistant") return;
		if (event.message.stopReason === "aborted" || event.message.stopReason === "error") return;
		const text = lastTextOf(event.message);
		if (text) requestTranslate(text, ctx);
	});

	pi.registerCommand("zh", {
		description: "Toggle Chinese translation under assistant replies",
		handler: async (_args, ctx) => {
			showZh = !showZh;
			ctx.ui.notify(showZh ? "中文翻译：开" : "中文翻译：关", "info");
			saveShowZh(showZh);
			// Backfill: translate recent assistant texts that have no translation yet.
			if (showZh) {
				try {
					const entries = ctx.sessionManager.getEntries();
					const texts: string[] = [];
					for (const e of entries) {
						const msg = (e as { message?: { role?: string; content?: Array<{ type: string; text?: string }> } }).message;
						if (msg?.role !== "assistant") continue;
						const t = lastTextOf(msg);
						if (t) texts.push(t);
					}
					for (const t of texts.slice(-BACKFILL_LIMIT)) requestTranslate(t, ctx);
				} catch {
					// session not readable; new replies will still translate
				}
			}
			refresh(ctx);
		},
	});

	// Manual trigger: (re-)translate the most recent assistant reply on demand.
	pi.registerCommand("translate", {
		description: "Manually translate the latest assistant reply to Chinese",
		handler: async (_args, ctx) => {
			let latest: string | undefined;
			try {
				const entries = ctx.sessionManager.getEntries();
				for (let i = entries.length - 1; i >= 0; i--) {
					const msg = (entries[i] as { message?: { role?: string; content?: Array<{ type: string; text?: string }> } }).message;
					if (msg?.role !== "assistant") continue;
					const t = lastTextOf(msg);
					if (t) {
						latest = t;
						break;
					}
				}
			} catch {
				// session not readable
			}
			if (!latest) {
				ctx.ui.notify("No assistant reply to translate", "warning");
				return;
			}
			if (!showZh) {
				showZh = true;
				saveShowZh(true);
			}
			forceTranslate(latest, ctx);
			ctx.ui.notify("Translating latest reply…", "info");
			refresh(ctx);
		},
	});

	// Prepend a quote glyph to every line of the translation (originals are
	// never touched — this only runs on the translation string).
	function quotePrefix(t: string): string {
		return t
			.split("\n")
			.map((line) => (line.trim() === "" ? "" : `» ${line}`))
			.join("\n");
	}

	pi.registerMarkdownTransformer((markdown, { messageType, isStreaming }) => {
		if (!showZh || isStreaming || messageType !== "assistant") return markdown;
		const key = markdown.trim();
		const t = translations.get(key);
		// t already carries » prefixes (applied per paragraph in reassemble);
		// prefixing again HERE would put the icons on the original instead.
		if (t) return `${markdown.trimEnd()}\n\n---\n\n${t}`;
		// Latest failure only: one notice on screen at a time.
		if (lastFailedKey === key) {
			return `${markdown.trimEnd()}\n\n---\n\n*(翻译不可用，doubao 未响应)*`;
		}
		return markdown;
	});
}
