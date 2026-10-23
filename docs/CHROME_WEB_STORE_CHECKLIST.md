# Chrome Web Store Checklist

## Current Extension Status

- Branch: `codex/chrome-extension-mvp`
- Manifest: Manifest V3
- Default API: `https://readinsight.bamamei.online`
- Privacy URL: `https://readinsight.bamamei.online/privacy`
- Main data store: **用户自己的飞书多维表格**（不是我们的数据库，也不是插件内的存储）
- 模型调用：**用户自带 API Key**，由用户在 Skill 初始化时配置

## Before Submission

- Load `extension/` as an unpacked extension in Chrome.
- Test selected text capture on a normal HTTPS webpage.
- Test AI diagnosis with the production API.
- Test saving selected knowledge points.
- Confirm the 飞书多维表格 `knowledge_points` table updates as expected.
- Confirm `/privacy` is live on the production website.
- Prepare Chrome Web Store screenshots and promotional images.

## Store Listing Draft

Name:

```text
ReadLoop
```

Short description:

```text
Practice English reading from real webpages with AI translation feedback.
```

Detailed description:

```text
ReadLoop helps English learners practice from real webpages they already care about. Select an English sentence or paragraph, open the side panel, write your own Chinese translation, and receive AI-powered comparison feedback. Useful weak points can be saved to your ReadLoop knowledge base for later review.

The extension does not store AI keys or database credentials. It only sends user-selected text and user-entered translations to the ReadLoop API when the user asks for diagnosis.
```

Category:

```text
Education
```

Language:

```text
Chinese (Simplified)
```

## Permission Justifications

`contextMenus`:

```text
Used to show "用 ReadLoop 练习这段英文" when the user selects text on a webpage.
```

`sidePanel`:

```text
Used to provide the translation practice and AI diagnosis workflow without leaving the current page.
```

`storage`:

```text
Used to save API Base URL and userId settings locally in Chrome.
```

`activeTab`:

```text
Used after a user action to work with the currently active page and selected text.
```

`<all_urls>` content script:

```text
Required because users practice English reading on arbitrary webpages. The content script only reads selected text and page metadata for the current reading practice flow.
```

## Data Usage Disclosure

User selected webpage text and user-entered translations are sent to the ReadLoop API for AI diagnosis. Selected knowledge points are saved only when the user clicks the save button. The extension does not sell user data and does not use the data for advertising.
