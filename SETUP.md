# Duke Estimating Extension — Setup Guide

## Step 1: Load the Extension in Chrome

1. Open Chrome and go to `chrome://extensions`
2. Enable **Developer Mode** (top-right toggle)
3. Click **Load unpacked**
4. Select the `DukeEstimatingExtensionV1` folder
5. The "Duke Estimating Sync" extension will appear — pin it to your toolbar

---

## Step 2: Set Up Google Cloud (One-Time)

You need a Google OAuth2 Client ID so the extension can read/write your spreadsheet.

1. Go to **https://console.cloud.google.com**
2. Create a new project (e.g., "Duke Estimating")
3. Go to **APIs & Services → Library** → search "Google Sheets API" → Enable it
4. Go to **APIs & Services → Credentials** → Create Credentials → **OAuth 2.0 Client ID**
5. Application type: **Web application**
6. Add an Authorized redirect URI:
   - Open the extension popup, click **⚙ Settings**
   - Copy the "Redirect URI" shown in the setup box (it looks like `https://xxxxx.chromiumapp.org/`)
   - Paste it into the Google Cloud redirect URIs field
7. Click **Create** and copy the **Client ID**

---

## Step 3: Configure the Extension

1. Click the extension icon → click **⚙** (Settings)
2. Paste your **Client ID** into the first field
3. The **Sheet ID** is pre-filled: `1iO37IiTagtu4OGEZSHA5C62tPRc5HOKMpq0UcsUI9ig`
4. **Sheet Tab Name**: Enter the exact name of your sheet tab (e.g., `2026 CUSTOM PLAN`)
5. Click **Save Settings**
6. Click **Test Connection** — it will open a Google sign-in prompt the first time

---

## Step 4: Using the Extension

### Auto-Sync from BuilderTrend
1. Open a BuilderTrend takeoff/estimate page
2. Click the extension icon
3. The **"Takeoff Detected"** panel appears with values found on the page
4. Click **Write to Sheet** to push them to Google Sheets

### Manual Entry
1. Click the extension icon on any page
2. Use the **Manual Entry** grid to type in values
3. Click **Write to Sheet**

### View Sheet Data
- The bottom panel shows your sheet in 4 tabs:
  - **Fixed Costs** (rows 1–25)
  - **Finished & Unfinished** (rows 27–47)
  - **Areas** (rows 49–78)
  - **Allowances** (rows 80–101)

---

## Cell Mapping

| Input | Sheet Cell |
|---|---|
| Basement SF | I3 |
| 1st Floor SF | I4 |
| 2nd Floor SF | I5 |
| 3rd Floor SF | I6 |
| Attic with Storage SF | I7 |
| Habitable Attic SF | I8 |
| Front Porch SF | I9 |
| Rear Porch SF | I10 |
| Rear Deck SF | I11 |
| Garage SF | I12 |
| # Exterior Doors | I17 |
| # Windows | I18 |
| # Baths | I19 |
| Cabinets LF | I20 |
| Countertops LF | I21 |
| # Staircases | I22 |
| # Front Porch Columns | I23 |
| # Garage Doors | I24 |
| # Interior Doors | I25 |
| SF Carpet | I26 |
| SF Hardwood | I27 |
| SF Tile | I28 |

---

## BuilderTrend Takeoff Labels

For auto-detection to work, label your BuilderTrend takeoff groups to match these names (case-insensitive):

- `Basement`, `1st Floor`, `2nd Floor`, `3rd Floor`
- `Attic with Storage`, `Habitable Attic`
- `Front Porch`, `Rear Porch`, `Rear Deck`, `Garage`
- `Cabinets`, `Countertops`
- `Exterior Doors`, `Windows`, `Baths`, `Staircases`
- `Front Porch Columns`, `Garage Doors`, `Interior Doors`
- `Carpet`, `Hardwood`, `Tile`
