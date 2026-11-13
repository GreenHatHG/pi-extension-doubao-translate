/**
 * doubao-translate — auto-translate assistant replies via doubao_hook.
 *
 * - Only the final prose reply is translated: the LAST text block of an
 *   assistant message with no real tool calls (watchdog_decide is exempt —
 *   it rides along with the final reply). Thinking blocks, tool calls and
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
	// separated), and each paragraph is split again where a table starts or
	// ends, so a table gets translated cell-by-cell even when a heading or a
	// lead-in sentence sits on the line right above it.
	type ProseChunk = { text: string; gap: string; para: number; table: boolean };

	// Mirror of marked's table rule (the TUI uses marked): a header line that
	// is not indented 4+ spaces (that is a code block), then a delimiter row
	// with 1+ dashes per cell and the same cell count. Any other shape is prose.
	function isAlignRow(line: string): string[] | null {
		const body = line.trim().replace(/^\|/, "").replace(/\|$/, "");
		if (!body) return null;
		const cells = body.split("|").map((c) => c.trim());
		return cells.every((c) => /^:?-+:?$/.test(c)) ? cells : null;
	}

	function isTableStart(lines: string[], i: number): boolean {
		const header = lines[i];
		if (header === undefined || header.trim() === "" || /^ {4,}/.test(header)) return false;
		if (!header.includes("|")) return false;
		const align = isAlignRow(lines[i + 1] ?? "");
		if (!align) return false;
		return splitTableRow(header).cells.length === align.length;
	}

	// marked ends table rows at a blank line or the start of another block.
	function startsNewBlock(line: string): boolean {
		return (
			/^ {0,3}(#{1,6}\s|>|```|~~~|[*+-]\s|\d+[.)]\s)/.test(line) ||
			/^ {0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line)
		);
	}

	function splitParagraph(para: string): Array<{ text: string; table: boolean }> {
		const lines = para.split("\n");
		const out: Array<{ text: string; table: boolean }> = [];
		let start = 0;
		let i = 0;
		const push = (end: number, table: boolean) => {
			if (end > start) out.push({ text: lines.slice(start, end).join("\n"), table });
		};
		while (i < lines.length) {
			if (isTableStart(lines, i)) {
				push(i, false);
				let j = i + 2; // header + delimiter row
				while (j < lines.length && lines[j].trim() !== "" && !startsNewBlock(lines[j])) j++;
				start = i;
				push(j, true);
				i = j;
				start = j;
			} else {
				i++;
			}
		}
		push(lines.length, false);
		return out;
	}

	// splitCode and reassemble both call this, so part indexes can never desync.
	function splitProseChunks(prose: string): ProseChunk[] {
		const out: ProseChunk[] = [];
		prose.split(/\n\s*\n/).forEach((para, paraIdx) => {
			splitParagraph(para).forEach((c, i) => {
				out.push({ ...c, para: paraIdx, gap: i === 0 ? (paraIdx === 0 ? "" : "\n\n") : "\n" });
			});
		});
		return out;
	}

	function splitCode(text: string): { parts: string[]; blocks: string[]; tables: boolean[] } {
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
		const parts: string[] = [];
		const tables: boolean[] = [];
		for (const raw of rawParts) {
			for (const c of splitProseChunks(raw)) {
				parts.push(c.text);
				tables.push(c.table);
			}
		}
		return { parts, blocks, tables };
	}

	// Split a table row on unescaped pipes, keeping its leading/trailing shape.
	function splitTableRow(line: string): { leading: boolean; trailing: boolean; cells: string[] } {
		const trimmed = line.trim();
		const leading = trimmed.startsWith("|");
		const trailing = trimmed.endsWith("|");
		let body = trimmed;
		if (leading) body = body.slice(1);
		if (trailing && body.endsWith("|")) body = body.slice(0, -1);
		return { leading, trailing, cells: body.split(/(?<!\\)\|/).map((c) => c.trim()) };
	}

	// Replace only cell text; the alignment row is copied byte-identical.
	function rebuildTable(block: string, trans: Map<string, string>): string {
		return block
			.split("\n")
			.map((line, row) => {
				if (row === 1 || line.trim() === "") return line;
				const { leading, trailing, cells } = splitTableRow(line);
				// A raw pipe inside translated text would add a column.
				const next = cells.map((cell, col) =>
					(trans.get(`${row}:${col}`) ?? cell).replace(/(?<!\\)\|/g, "\\|"),
				);
				return `${leading ? "| " : ""}${next.join(" | ")}${trailing ? " |" : ""}`;
			})
			.join("\n");
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
			const chunks = splitProseChunks(prose);
			const paras: ProseChunk[][] = [];
			for (const c of chunks) (paras[c.para] ??= []).push(c);
			paras.forEach((group) => {
				let trans = "";
				for (const c of group) {
					out += c.gap + c.text;
					const t = byPart.get(partIdx++);
					// A translated table must stay raw markdown; a » prefix on every
					// row would stop the TUI from parsing it as a table.
					// Blank line between translated chunks so a table followed by a
					// block start cannot swallow the » lines as extra rows.
					if (t) trans += `${trans ? "\n\n" : ""}${c.table ? t : quotePrefix(t)}`;
				}
				if (trans) out += `\n\n${trans}`;
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

	// One entry sent to doubao. Table cells carry row/col so the reply can be
	// stitched back into the original table instead of replacing it wholesale.
	type Unit = { partIdx: number; text: string; row?: number; col?: number };

	function buildRequest(units: Unit[]): { body: string | null; count: number } {
		if (units.length === 0) return { body: null, count: 0 };
		if (units.length === 1) return { body: units[0].text, count: 1 };
		const body = units.map((u, i) => `【${i + 1}】${u.text}`).join("\n\n");
		return { body, count: units.length };
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
		const { parts, blocks, tables } = splitCode(text);
		const units: Unit[] = [];
		parts.forEach((p, i) => {
			const core = p.trim();
			if (core.length === 0) return;
			if (tables[i]) {
				p.split("\n").forEach((line, row) => {
					if (row === 1 || line.trim() === "") return; // alignment row
					splitTableRow(line).cells.forEach((cell, col) => {
						if (!cell) return;
						if (!force && (mostlyCJK(cell) || !/[A-Za-z]/.test(cell))) return;
						units.push({ partIdx: i, text: cell, row, col });
					});
				});
				return;
			}
			if (force || (core.length >= MIN_LENGTH && !mostlyCJK(core))) {
				units.push({ partIdx: i, text: parts[i] });
			}
		});
		if (units.length === 0) return null;
		const { body, count } = buildRequest(units);
		if (!body) return null;
		const reply = await semaphore(() => translateProse(body));
		if (!reply) return null;
		let translated: string[];
		if (count === 1) {
			translated = [reply];
		} else {
			const segs = splitTranslation(reply, count);
			if (!segs) return null; // markers lost entirely: show original, no retry
			translated = segs;
		}
		// Map marker slots back onto parts; table cells land in their own map
		// so the table can be rebuilt with the original shape. Dropped
		// segments get retried.
		const byPart = new Map<number, string>();
		const cellTrans = new Map<number, Map<string, string>>();
		const missing: Array<{ partIdx: number; text: string; row?: number; col?: number }> = [];
		const putCell = (partIdx: number, row: number, col: number, t: string) => {
			let m = cellTrans.get(partIdx);
			if (!m) {
				m = new Map();
				cellTrans.set(partIdx, m);
			}
			m.set(`${row}:${col}`, t.replace(/\s*\n+\s*/g, " "));
		};
		units.forEach((u, i) => {
			const t = translated[i];
			if (t && !t.startsWith("*(translation unavailable")) {
				if (u.row !== undefined && u.col !== undefined) putCell(u.partIdx, u.row, u.col, t);
				else byPart.set(u.partIdx, t);
			} else {
				missing.push({ partIdx: u.partIdx, text: u.text, row: u.row, col: u.col });
			}
		});
		if (missing.length > 0) {
			const filled = await fillMissing(missing);
			filled.forEach((t, i) => {
				const m = missing[i];
				if (!t) {
					// A table cell keeps its original text; prose shows the notice.
					if (m.row === undefined) byPart.set(m.partIdx, missingNotice(i + 1));
					return;
				}
				if (m.row !== undefined && m.col !== undefined) putCell(m.partIdx, m.row, m.col, t);
				else byPart.set(m.partIdx, t);
			});
		}
		for (const [partIdx, cells] of cellTrans) {
			byPart.set(partIdx, rebuildTable(parts[partIdx], cells));
		}
		const out = reassemble(text, blocks, byPart);
		if (!force && out.trim() === text.trim()) return null;
		return out;
	}

	// Doubao sometimes drops or merges a 【n】 marker. Retry those segments one by
	// one (no marker needed for a single cell), then give up per segment.
	async function fillMissing(
		missing: Array<{ partIdx: number; text: string; row?: number; col?: number }>,
	): Promise<Map<number, string | null>> {
		const filled = new Map<number, string | null>();
		await Promise.all(
			missing.map(async (m, i) => {
				const t = await semaphore(() => translateProse(m.text.trim()));
				filled.set(i, t);
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
		// Footer status: show while the request is in flight. setStatus may be
		// absent in older pi builds; degrade to silent.
		const setStatus = ctx.ui.setStatus?.bind(ctx.ui);
		const clearStatus = () => setStatus?.(STATUS_KEY, undefined);
		const showStatus = (s: string) => setStatus?.(STATUS_KEY, s);
		if (!force) {
			if (translations.has(key) || pending.has(key)) return;
			// Auto path skipped this reply (too short / already Chinese). Say why
			// in the footer — same spot as the timeout notice — instead of silence.
			if (key.length < MIN_LENGTH || mostlyCJK(key)) {
				showStatus("· 无需翻译（太短或已是中文）");
				setTimeout(clearStatus, STATUS_LINGER_MS);
				return;
			}
		}
		pending.add(key);
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

	// Watchdog's control-plane call: bundled AFTER the final reply text in the
	// same assistant message, so it must not disqualify that text. Real tool
	// work does — its text blocks are mid-turn progress, never the final reply.
	const CONTROL_PLANE_TOOLS = new Set(["watchdog_decide"]);

	// Last text block of an assistant message = the final prose reply.
	function lastTextOf(message: {
		content?: Array<{ type: string; text?: string; name?: string }>;
	}): string | undefined {
		if (!Array.isArray(message.content)) return undefined;
		if (message.content.some((c) => c.type === "toolCall" && !CONTROL_PLANE_TOOLS.has(c.name ?? ""))) {
			return undefined;
		}
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
