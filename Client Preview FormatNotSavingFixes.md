# Client Preview — Proposal Text Not Saving: Fixes & How It Works

## Summary of What Broke

After running "Start Prelim - Budget Client Preview," the proposal text (intro and closing) was showing as BT's default/blank text instead of the injected Keel content. The flow completed successfully (log reached "✓ Client preview setup complete") but the text was never visible.

---

## Root Cause 1: Stale JobId from Performance Entries

### What was happening
The code found the proposal's `jobId` by scanning `performance.getEntriesByType('resource')` for any past network request matching `/apix/v2/Proposals/draft?jobId=(\d+)`. It took the **first** match it found.

Because BT is a single-page application, performance entries accumulate across the entire session. If the user had worked on a different job earlier, or if BT made internal draft requests during navigation, the first matching entry was a **stale jobId** from a prior proposal — not the one currently open in the proposal builder.

This meant every PUT request was writing to the wrong proposal entirely. The correct proposal (the one the user could see) never received the injected text.

### How it was fixed

**Step 1 — Snapshot resource count before clicking buildProposal**

Before clicking the "Build Proposal" button, the code records how many performance entries currently exist:
```js
var preCount = performance.getEntriesByType('resource').length;
```

**Step 2 — Wait for the proposal page's own draft request to fire**

After clicking `buildProposal`, the code polls performance entries in a loop (up to 6 seconds, checking every 150ms). It scans **only entries added after the click** (index ≥ preCount), iterating **backwards** (newest first) so it gets the most recent matching request:
```js
for (var ri = resources.length - 1; ri >= startIdx; ri--) {
  var m = resources[ri].name.match(/\/apix\/v2\/Proposals\/draft\?jobId=(\d+)/);
  if (m) return m[1];
}
```

This guarantees the captured jobId is from the proposal page that just loaded — not from any prior session activity.

**Step 3 — Pass the known jobId into all subsequent executeScript calls**

The captured `proposalJobId` is passed as an argument (`knownJobId`) into both the fill function and the locking PUT function. Those functions use it directly instead of scanning performance entries again:
```js
var jobId = knownJobId || null;
// fallback: scan backwards if somehow not passed
if (!jobId) { ... }
```

---

## Root Cause 2: Locking PUT Rejected with 400

### What was happening
After the main save, the code fired a "locking PUT" — a final write to lock in the exact intro/closing HTML after CKEditor's save might have normalized it. This locking PUT used a **simple merge-patch** with only two fields:
```json
{ "introductionText": "...", "closingText": "..." }
```

BT's API **changed** and now rejects this partial payload with a **400 error**, even though the `content-type: application/merge-patch+json` header was set. The 400 meant the lock never applied, and whatever CKEditor saved on its own was what stuck.

### How it was fixed

The locking PUT was changed to use the **same full GET → PUT pattern** as the main save:
1. GET the current draft from `/apix/v2/Proposals/draft?jobId=...`
2. Flatten and reconstruct the full proposal body (same logic as the main save)
3. Override `introductionText` and `closingText` with our HTML
4. PUT the full body — BT accepts this and returns 200
5. Immediately do a verification GET and log `verifyIntroLen` to confirm the text actually stuck

```js
// After the locking PUT:
var vxhr = new XMLHttpRequest();
vxhr.open('GET', '/apix/v2/Proposals/draft?jobId=' + jobId, false); // sync
// ... parse response, read intro.length → verifyIntroLen
```

The log line `Lock result: status=200 verifyIntroLen=2774` confirms both the PUT succeeded and the text is in the database at the expected length.

---

## Diagnostic Logging Added

Several log lines were added to surface failures that were previously silent:

| Log line | What it tells you |
|---|---|
| `Proposal jobId: XXXXXXXX` | The jobId captured from the fresh proposal page load |
| `Proposal editors filled. [ck:2 jobId:... branch:full-put put:200]` | CKEditor instance count, which jobId was used, which save branch ran, PUT HTTP status |
| `Lock result: status=200 verifyIntroLen=2774` | Whether the locking PUT succeeded and whether the text is actually in the database |

### Branch values in the fill log
- `full-put` — normal path: GET draft succeeded, full PUT was sent
- `no-draft-savebtn` — GET returned null, fell back to clicking the save button
- `no-jobid-savebtn` — jobId was not found at all, fell back to clicking the save button
- `no-ckeditor` — `window.CKEDITOR` doesn't exist on the page
- `too-few-editors` — fewer than 2 CKEditor instances found

---

## Full Flow After Fixes

```
1. Snapshot performance entry count (preCount)
2. Click buildProposal button
3. Poll new performance entries until proposal draft request fires → capture proposalJobId
4. Fill CKEditor instances (editorA = intro, editorB = closing)
5. GET current draft using proposalJobId
6. Build full PUT body from draft, override introductionText + closingText
7. PUT full body → 200
8. Set CKEditor data again (belt-and-suspenders)
9. Click BT's save button → CKEditor saves its content (which matches our HTML)
10. Locking PUT: GET → full PUT again with our HTML → 200
11. Verify GET → confirm verifyIntroLen > 0
12. Navigate to client preview tab
13. Configure display settings (remove cost code / unit price columns)
14. Collapse/expand proposal groups per CSA/lender flags
```

---

## If This Breaks Again — Checklist

1. **Check `Proposal jobId` in the log** — if it says "not found," BT changed the draft API URL pattern. Update the regex: `/\/apix\/v2\/Proposals\/draft\?jobId=(\d+)/`

2. **Check `branch` in the fill log** — if it says `no-ckeditor` or `too-few-editors`, BT replaced CKEditor with a different editor. The `setData` calls will need to be rewritten for the new editor.

3. **Check `put:` status in the fill log** — if it's not 200, BT changed the proposal PUT endpoint or required fields. Inspect the Network tab in DevTools on the proposal page to see what a manual save sends.

4. **Check `Lock result: status=`** — if it's not 200, the full body PUT is being rejected. Compare the body structure to what BT's own save button sends (visible in DevTools Network tab).

5. **Check `verifyIntroLen`** — if status is 200 but verifyIntroLen is small (< 500), the API is accepting the PUT but the `introductionText` field name may have changed. Check the GET response structure in the console: `fetch('/apix/v2/Proposals/draft?jobId=XXXXX').then(r=>r.json()).then(console.log)`
