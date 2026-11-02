# Citation Workflow Connector (optional)

1. Extract the ZIP into a folder you will keep.
2. Open `chrome://extensions` or `edge://extensions` on desktop, enable **Developer mode**, choose **Load unpacked**, and select the extracted folder containing `manifest.json`.
3. Reload https://marronyao.github.io/Citation_Workflow/ and confirm **Connector connected**.
4. When a PDF is blocked, click **Verify & continue** for the source you want. Complete any verification or sign-in yourself in the new tab, keep it on the requested paper, and open its PDF if necessary. The connector looks for an available matching PDF and returns its bytes to the app. An active ZIP can then continue with the next item.

Use **Cancel verification**, **Stay here** or Escape to stop/skip. Closing the source tab also stops the request. Waiting expires after 15 minutes. If you skip a paper in a ZIP, the remaining items continue. Ordinary cloud downloads still work without this extension.

The extension uses `scripting` and an explicit list of academic/source hosts. It has no cookie-reading, browsing-history or downloads permissions. Browser requests use the existing session; session cookies are never sent to Citation Workflow or its cloud API. PDF bytes are transferred in chunks directly to the app tab and held in memory for downloads/ZIPs (80 MB per PDF, 100 MB cached in the page). Closing or reloading the app discards them. A visible source tab is opened for every explicit retrieval action. Only the Citation Workflow app path can initiate jobs. No scripts solve or submit verification challenges.

Some sites reject extension requests even after verification, require another PDF navigation, use an unsupported download host, or do not expose an accessible PDF. These cases remain errors or waiting states; successful completion of a CAPTCHA is not a guarantee of a downloadable file. This build is an unpacked extension, not a store-published extension. To update, replace the extracted files and press **Reload** on its extension card. To remove it, use **Remove** on that card.

Code licence: MIT (see LICENSE).
