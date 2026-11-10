---
created_at: 2026-11-10
updated_at: 2026-11-10
topic: watchdog-toolcall-blocks-final-text
status: resolved
affected_modules: [src/index.ts]
tags: [doubao, translate, lastTextOf, watchdog, toolCall, message-classification]
---

# Doubao Translate: watchdog_decide toolCall Blocks Translation of the Final Reply

## 1. Context & Problem
pi-watchdog bundles its `watchdog_decide` toolCall into the SAME assistant message as the final visible reply text (block order: thinking, text, toolCall). `lastTextOf()` rejected any message containing a toolCall, so the final prose was never queued for translation — auto path skipped it and `/translate` scanned past it to an older text. The user saw "✓ 已翻译" (from a previous reply) but no translation content.

## 2. Pitfalls & Failed Attempts (Gotchas - DO NOT REPEAT)
- **Assumption**: "assistant message with a toolCall = mid-turn progress, never the final reply".
  - **Failure Reason**: True for real tools (`bash`, `read` — their text blocks are progress chatter), false for control-plane calls. `watchdog_decide` rides along AFTER the final text. Verified in session jsonl: entry with blocks `[thinking, text(3386 chars), toolCall(watchdog_decide)]` returned `undefined` from old `lastTextOf`.
- **Gotcha**: Diagnosing from the footer alone misleads — the ✓ status belongs to a DIFFERENT (earlier) reply's translation. Always check the session jsonl message content before trusting UI state.

## 3. Decision & Verified Solution
- **Chosen Approach**: Exempt control-plane tools in `lastTextOf` via an allowlist. Real tool calls still disqualify the message.
- **Key Changes**: `src/index.ts` — new `CONTROL_PLANE_TOOLS` set; `lastTextOf` only returns `undefined` when a NON-exempt toolCall is present. Fix verified by simulating old vs new logic against the real session file: final text (3386 chars) now extracted; entries with `bash` calls still excluded; empty `content: []` messages still return None.
- **Minimal Code / Command Reference**:
  ```ts
  const CONTROL_PLANE_TOOLS = new Set(["watchdog_decide"]);
  if (message.content.some((c) => c.type === "toolCall" && !CONTROL_PLANE_TOOLS.has(c.name ?? ""))) {
    return undefined;
  }
  ```

## 4. Hard Constraints for Future AI
- NEVER add new control-plane/UX tools to pi without checking whether their toolCall lands in the final assistant message — if so, add them to `CONTROL_PLANE_TOOLS`.
- ALWAYS verify `lastTextOf` changes against real session jsonl entries, not synthetic fixtures — block ordering varies by extension.
- NEVER treat "message has toolCall" as "message is mid-turn" without checking the tool name.
