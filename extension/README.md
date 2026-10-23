# ReadLoop Chrome Extension

This folder contains the Chrome/Edge Manifest V3 extension for ReadLoop.

## Local Test

1. Open Chrome and visit `chrome://extensions`.
2. Enable Developer mode.
3. Click "Load unpacked".
4. Select this `extension/` directory.
5. Open any English webpage, select text, and open the ReadLoop side panel.

## Production Defaults

The extension calls:

```text
https://readinsight.bamamei.online
```

It does not contain AI keys, database connection strings, or Supabase secrets.

## Package For Chrome Web Store

Run from the repository root:

```bash
cd extension
zip -r ../readinsight-extension.zip . -x "*.DS_Store"
```

The zip root must contain `manifest.json`.

## Permission Rationale

`contextMenus`: Adds a right-click action for selected English text.

`sidePanel`: Opens the translation practice panel beside the current webpage.

`storage`: Saves API Base URL and userId settings.

`activeTab`: Lets the extension work with the tab the user is actively using after a direct user action.

`<all_urls>` content script match: Reads selected text from arbitrary English webpages because the product is designed for real reading scenarios across the web.
