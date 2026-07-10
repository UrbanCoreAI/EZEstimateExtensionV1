# Why Water & Sewer Keep Going to Custom Selection Allowances

## The Short Answer

The code that creates new Site Allowances items (Sewer, Water) was using the wrong CSS selector to click the "Item" option from the BuildingTrend + button dropdown. The wrong selector matched the outer `<li>` container instead of the inner text node — which means if any other dropdown menu happened to be open or partially rendered on the page at the same time, it could click the wrong "Item" option, attaching the new line item to whatever group that other dropdown belonged to (often Custom Selection Allowances, since it runs close in the workflow).

---

## What Happens in BuildingTrend When a Line Item is Created

When you click the `+` button next to a group row (like "Site Allowances") in BT, a small dropdown appears with options: **Item**, Group, etc. Clicking **Item** opens a new line item creation panel, and that item is pre-attached to the group whose `+` button you clicked.

The item's group assignment is set at creation time by which `+` button was clicked, not by the "cost code" or "parent group" metadata fields. Those fields are just descriptive tags — they do not move the item between groups.

---

## The Two Selectors — Wrong vs. Right

### Wrong (was in popup.js)
```js
var opts = document.querySelectorAll(
  '.ant-dropdown-menu-item, [class*="DropdownMenuItem"], li[role="menuitem"]'
);
```
- `.ant-dropdown-menu-item` matches the outer `<li>` wrapper of every Ant Design dropdown item on the entire page — not just the one that appeared from the Site Allowances `+` button.
- If Custom Selection Allowances left its `+` dropdown open (or partially rendered) from an earlier step, this selector finds its "Item" option first and clicks it there instead.
- Result: item created under Custom Selection Allowances.

### Correct (tabpicker.js, now also popup.js)
```js
var opts = document.querySelectorAll('.ant-dropdown-menu-title-content');
```
- `.ant-dropdown-menu-title-content` matches the inner `<div>` that holds only the visible label text.
- Ant Design only renders one dropdown's menu items in the DOM at a time, so this selector is unambiguous.
- Combined with an exact text match `=== 'Item'` (capital I, no trim issues), it reliably finds the right option.

---

## The Correct Coding Pattern for createSiteItem

Any time you need to add a new item to **Site Allowances** (or any specific group) via scripting, follow this sequence exactly:

### Step 1 — Use the search bar to scroll the group into view
```js
searchInput.value = 'Site Allowances';
searchInput.dispatchEvent(new Event('input', { bubbles: true }));
// wait 500ms for results
```

### Step 2 — Click the search result using the exact text match
```js
// CORRECT selector for BT search results:
var results = document.querySelectorAll('.LineItemResult, [class*="LineItem"][class*="Result"]');
for (var i = 0; i < results.length; i++) {
  if ((results[i].innerText || '').trim().toLowerCase() === 'site allowances') {
    results[i].click();
    break;
  }
}
// wait 700ms for the table to scroll and render the group row
```

### Step 3 — Find the + button for the Site Allowances group row
```js
// Poll for the group row. BT is virtualized — the row may not be in DOM until step 2 scrolls it in.
var plusBtn = null;
var rows = document.querySelectorAll('.WorksheetGroupCellActions');
for (var r = 0; r < rows.length; r++) {
  var titleEl = rows[r].querySelector('.proposalFormatGroupCellTitle');
  if (titleEl && (titleEl.innerText || '').trim().toLowerCase() === 'site allowances') {
    plusBtn = rows[r].querySelector('button.AddItemsDropdown') ||
      (rows[r].parentElement && rows[r].parentElement.querySelector('button.AddItemsDropdown'));
    break;
  }
}
if (!plusBtn) return; // group not found — bail out, do not proceed
plusBtn.click();
// wait 400ms for dropdown to render
```

### Step 4 — Click "Item" from the dropdown using the CORRECT selector
```js
// ✅ CORRECT — inner text node, unambiguous even if other dropdowns are in DOM
var opts = document.querySelectorAll('.ant-dropdown-menu-title-content');
var itemOpt = null;
for (var i = 0; i < opts.length; i++) {
  if ((opts[i].textContent || '').trim() === 'Item') { // exact match, capital I
    itemOpt = opts[i];
    break;
  }
}
if (!itemOpt) return; // dropdown not ready — bail out
itemOpt.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
itemOpt.click();
// wait 600ms for item creation panel to open
```

### Step 5 — Clear search bar (important — prevents stale search from blocking DOM polling)
```js
searchInput.value = '';
searchInput.dispatchEvent(new Event('input', { bubbles: true }));
// wait 600ms
```

### Step 6 — Fill in the item fields and save
Fill title input, cost code, parent group, unit cost using the new item's input fields, then click Save.

---

## Why This Bug Keeps Recurring

1. **Two separate files both have a createSiteItem** — tabpicker.js (proposal flow) and popup.js (Write to Estimate panel). When one is fixed, the other is forgotten.

2. **The wrong selector feels like it should work** — `.ant-dropdown-menu-item` is the standard Ant Design class for a clickable menu item. It works fine in isolation. It only breaks when multiple dropdowns have been opened in the same session and the DOM still has residual menu elements.

3. **The failure is silent** — the wrong "Item" option still creates a line item. The item just lands in the wrong group. No JS error is thrown, no warning in the log (unless you add one).

---

## The Rule Going Forward

**Always use `.ant-dropdown-menu-title-content` with an exact case-sensitive text match when clicking a dropdown option in BT.**

Never use `.ant-dropdown-menu-item`, `[class*="DropdownMenuItem"]`, or `li[role="menuitem"]` — these match outer wrappers that are not unique per-dropdown.

If you add a third code path in the future that creates items programmatically, copy the Step 4 pattern from this document exactly.
