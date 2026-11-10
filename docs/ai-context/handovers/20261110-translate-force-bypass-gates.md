---
created_at: 2026-11-10
updated_at: 2026-11-10
topic: translate-force-bypass-gates
status: resolved
affected_modules: [src/index.ts]
tags: [doubao, translate, gating, force-translate, footer-status]
---

# Doubao Translate: Manual /translate Bypasses All Gates + Auto-Skip Footer Status

## 1. Context & Problem
Manual `/translate` refused to run when the latest reply was short, already Chinese, or already translated. It printed "Reply needs no translation" and did nothing. Separately, the auto path skipped such replies in total silence — no footer status, user saw nothing.

## 2. Pitfalls & Failed Attempts (Gotchas - DO NOT REPEAT)
- **Attempt**: Keep `forceTranslate` returning a boolean and notify "needs no translation" on false.
  - **Failure Reason**: User explicitly wants manual `/translate` to ALWAYS send. Any gate on the manual path is wrong by definition.
- **Attempt**: Drop identical-output results (`reassemble(...) === text` → null) on the force path.
  - **Failure Reason**: Doubao may legitimately echo the text back unchanged; force mode must still show the result, not swallow it as "no translation needed".

## 3. Decision & Verified Solution
- **Chosen Approach**: Thread a `force` flag through the whole chain: `forceTranslate` → `requestTranslate` → `translateText`. Auto path keeps all gates; manual path sends unconditionally. Auto-path skips (too short / already Chinese) now show a 3s footer status instead of silence.
- **Key Changes**: `src/index.ts`
  - `forceTranslate`: no `MIN_LENGTH`/`mostlyCJK` check, no dedupe, void return.
  - `requestTranslate(text, ctx, notifyDone, fromRetry, force)`: gates wrapped in `if (!force)`; skip branch shows `· 无需翻译（太短或已是中文）` via `setStatus` (same spot/linger as the timeout notice), then returns.
  - `translateText(text, force)`: force includes every non-empty part; identical-output check runs only when `!force`.
  - Health-poll auto-retry passes through the same force flag; `fromRetry` still prevents re-arming the poll loop.
- **Minimal Code / Command Reference**:
  ```ts
  if (!force) {
    if (translations.has(key) || pending.has(key)) return;
    if (key.length < MIN_LENGTH || mostlyCJK(key)) {
      showStatus("· 无需翻译（太短或已是中文）");
      setTimeout(clearStatus, STATUS_LINGER_MS);
      return;
    }
  }
  ```

## 4. Hard Constraints for Future AI
- NEVER gate the manual `/translate` path with `MIN_LENGTH`, `mostlyCJK`, or dedupe — it must always send.
- ALWAYS keep the auto path gated (those gates exist to protect the doubao quota).
- ALWAYS show a footer status (`ctx.ui.setStatus` with `STATUS_KEY`) when the auto path silently drops a reply — silence reads as a bug to the user.
