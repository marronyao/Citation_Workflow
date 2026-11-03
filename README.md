# Citation Workflow

Find a paper by DOI, preprint ID or repository link, download its PDF and generate an editable citation — directly in your browser.

**[Open Citation Workflow](https://marronyao.github.io/Citation_Workflow/)** · **[Release v0.5.1](https://github.com/marronyao/Citation_Workflow/releases/tag/v0.5.1)** · **[Feedback](https://github.com/marronyao/Citation_Workflow/issues/new?template=feedback.yml)**

## Use the website

1. Open the website. Standard cloud downloads need no local helper, Python, extension, repository download or installation.
2. Enter a DOI, arXiv ID (including an explicit version), or supported preprint/conference paper link, and select **Find paper**.
3. Review the paper and citation. Select **Download PDF** for a standard browser download.
4. For several papers, select **Batch download**, enter one identifier per line, and select **Find papers**. Download individually or choose **Download all as ZIP**.

Your browser controls the save location and duplicate filenames. Enable its “Ask where to save each file” option to choose a folder for each download. The website cannot write directly to an arbitrary folder. Optional automatic download in Download settings is off by default; browsers may require an extra click or permission.

### Optional browser connector

For sources that require browser verification or sign-in, the optional **Citation Workflow Connector** runs in desktop Chrome/Edge. Use **Connector setup** on the website to download its ZIP, extract it, enable Developer mode at `chrome://extensions` or `edge://extensions`, choose **Load unpacked**, and select the extracted folder. Reload the app and confirm **Connector connected**. It is an unpacked extension, not a Chrome Web Store listing.

Choose **Verify & continue** for a source to open a new tab. Complete the site's verification or sign-in yourself, keep the tab on the requested paper and open its PDF if necessary. The connector attempts retrieval using that browser session and returns PDF bytes directly to the app. A waiting batch ZIP resumes after receiving the PDF. **Skip paper & continue** moves to the next item; cancel, tab closure and a 15-minute waiting limit are supported. Received PDFs are reused in the current page's ZIP downloads, within a 100 MB in-memory cache. Reloading the page discards this cache.

No login cookies or PDF bytes are uploaded to Cloudflare. The extension has an explicit source-host list and scripting permission; it cannot guarantee that a source allows extension downloads after verification. Standard cloud downloads remain available without installation. See [connector installation and limitations](extension/README.md).

## Features and limits

- Cloud metadata from Crossref, DataCite and original repositories; no localhost connection.
- Journal articles, preprints and individual PMLR, NeurIPS, CVF and ACL conference-paper pages. Explicit arXiv versions are preserved.
- Verified PDF retrieval from original repositories, PMC and supported publishers, with DOI-based Sci-Hub, Z-Library and Library Genesis fallback requests. Source history and direct source links explain failed downloads.
- APA 7, Vancouver, AMA 11, Harvard, ACS, Chicago 18 (author-date), IEEE, MLA 9, and OSCOLA, ordered for practical relevance to biology with APA first; BibTeX, RIS / EndNote, and a custom format inferred from a reference example follow. Editable references, titles and APA proper nouns.
- Live batch progress with the current identifier, lookup/retrieval stage, elapsed time, PDF transfer size and ZIP packing status.
- PDFs named after the article title; ZIP downloads with a report. Invalid or unavailable papers do not stop other items.
- One public GitHub feedback form: download/citation problem, paper DOI or description, optional contact email. Contact emails are visible publicly.

Limits: **20 papers per batch**, **80 MB per PDF**, **100 MB per ZIP**. Large batches use browser memory; download large PDFs individually. An internet connection and an available cloud service are required. Subscription access, verification pages and sources blocking cloud traffic may prevent a download; use the official article link for institutional access. References remain available without a PDF.

Cloud retrieval uses original repositories, PMC and an explicit supported publisher domain list first, then configured Sci-Hub, Z-Library and Library Genesis public endpoints when a DOI is available. The adapters request matching records and verify PDF bytes before offering a cloud download. Search history distinguishes actual attempts, no match, timeouts, access denial, login and manual verification. Failed sources have direct browser links. No accounts or browser cookies are sent to the cloud service; automated challenge solving and headless mirror discovery are not included. Reachability and downloads depend on each source and are not guaranteed. ResearchGate and Anna’s Archive are not connected. PubMed is not queried.

Failed searches list unconnected services as **Not searched**, separately from configured source failures or unavailable PDFs. Official Elsevier HTTP/HTML resolver redirects are supported with bounded, validated redirects. See [source retrieval diagnostics](docs/source-retrieval.md).

## Compatibility and validation

The cloud website uses browser APIs on Windows, macOS and Linux without OS setup. **macOS is available but has not undergone complete testing.** Native Safari, iOS and Android downloads have not been fully tested. Browser permissions and download behaviour vary.

v0.4.0 basic checks include real cloud PDF downloads from PMLR, arXiv, PLOS Biology, Nature and Journal of Statistical Software; browser single-PDF and mixed-batch ZIP checks; citation formats, custom styles, signed tickets, source restrictions and ZIP integrity. See [release notes](docs/releases/v0.4.0.md).

## Architecture

GitHub Pages serves the frontend. `cloud/worker.mjs` runs on Cloudflare Workers at `https://citation-workflow-api.marronyao.workers.dev`. Metadata and short-lived source results are cached at the edge; PDF bytes stream through the API to the browser without a server save folder. ZIPs are created in the browser. There are no personal paper libraries or user accounts.

The cloud API receives paper identifiers and custom-style reference examples. Preferences use browser local storage. Expiring HMAC-signed paper/download tickets, HTTPS source allowlists, redirect validation, bounded responses, CORS and rate limiting restrict the API. Credentials are not embedded in the public frontend.

## Development and deployment

Maintainers only — website users need none of these tools. Node.js 22+ and Python 3 are used by the full suite; Python independently validates ZIPs.

```sh
npm ci
npm run build
npm test
npm run cloud:types
npm run cloud:check
```

Serve static files on `http://127.0.0.1:8080` to develop against the deployed cloud API. For backend emulation, run `npx wrangler dev --config cloud/wrangler.jsonc`, put a development signing secret in gitignored `cloud/.dev.vars`, and temporarily point the frontend API constant at the emulator.

Cloud deployment:

```sh
npx wrangler login
npx wrangler secret put SIGNING_KEY --config cloud/wrangler.jsonc
npm run cloud:deploy
```

Use a cryptographically random secret of at least 32 bytes. Keep it in Cloudflare secret storage, never in Git. Redeploys preserve the existing secret. Source bindings are declared in `cloud/wrangler.jsonc`. The initial v0.4.0 backend was deployed through the authenticated Cloudflare connector with this configuration.

GitHub Actions checks Windows and Linux and publishes frontend files to Pages on pushes to `main`. Releases are opt-in: manually run the Pages workflow with **publish_release** enabled to publish using `package.json` and `docs/releases/vX.Y.Z.md`; the default is off. A separate macOS workflow checks automated compatibility. **Worker updates require separate deployment**; the Pages workflow has no Cloudflare credentials.

The Python companion (`server.py`, `paper_metadata.py`, `fulltext_sources.py`, `start.bat`, `start.sh`) remains as legacy developer/reference code. It is not shipped to Pages, called by the v0.4.0 frontend, or required on a new device. Historical notes describe earlier local versions.

## Credits and licence

MIT. Citation.js, citeproc-js and CSL styles power formatting. See [third-party notices](THIRD_PARTY_NOTICES.md) and `vendor/licenses/`. Metadata and PDF access depend on the respective sources’ availability and terms.
