# Citation Workflow

Find a paper by DOI, preprint ID or repository link, download its PDF and generate an editable citation — directly in your browser.

**[Open Citation Workflow](https://marronyao.github.io/Citation_Workflow/)** · **[Release v0.4.0](https://github.com/marronyao/Citation_Workflow/releases/tag/v0.4.0)** · **[Feedback](https://github.com/marronyao/Citation_Workflow/issues/new?template=feedback.yml)**

## Use the website

1. Open the website. No local helper, Python, extension, repository download or installation is required.
2. Enter a DOI, arXiv ID (including an explicit version), or supported preprint/conference paper link, and select **Find paper**.
3. Review the paper and citation. Select **Download PDF** for a standard browser download.
4. For several papers, select **Batch download**, enter one identifier per line, and select **Find papers**. Download individually or choose **Download all as ZIP**.

Your browser controls the save location and duplicate filenames. Enable its “Ask where to save each file” option to choose a folder for each download. The website cannot write directly to an arbitrary folder. Optional automatic download in Download settings is off by default; browsers may require an extra click or permission.

## Features and limits

- Cloud metadata from Crossref, DataCite and original repositories; no localhost connection.
- Journal articles, preprints and individual PMLR, NeurIPS, CVF and ACL conference-paper pages. Explicit arXiv versions are preserved.
- Verified PDF retrieval from original repositories, PMC and supported open-access publishers. Source history and official access links explain failed downloads.
- APA 7, Vancouver, Harvard, BibTeX, RIS / EndNote, and a custom format inferred from a reference example. Editable references, titles and APA proper nouns.
- PDFs named after the article title; ZIP downloads with a report. Invalid or unavailable papers do not stop other items.
- One public GitHub feedback form: download/citation problem, paper DOI or description, optional contact email. Contact emails are visible publicly.

Limits: **20 papers per batch**, **80 MB per PDF**, **100 MB per ZIP**. Large batches use browser memory; download large PDFs individually. An internet connection and an available cloud service are required. Subscription access, verification pages and sources blocking cloud traffic may prevent a download; use the official article link for institutional access. References remain available without a PDF.

Cloud retrieval uses original repositories, PMC and an explicit supported publisher domain list. The legacy helper’s headless-browser mirror discovery and Sci-Hub / ResearchGate / Z-Library / Library Genesis / Anna’s Archive automation are **not part of the cloud service**. The UI reports only sources actually checked. PubMed is not queried.

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

GitHub Actions checks Windows and Linux, publishes frontend files to Pages, then creates a Release using `package.json` and `docs/releases/vX.Y.Z.md`. A separate macOS workflow checks automated compatibility. **Worker updates require separate deployment**; the Pages workflow has no Cloudflare credentials.

The Python companion (`server.py`, `paper_metadata.py`, `fulltext_sources.py`, `start.bat`, `start.sh`) remains as legacy developer/reference code. It is not shipped to Pages, called by the v0.4.0 frontend, or required on a new device. Historical notes describe earlier local versions.

## Credits and licence

MIT. Citation.js, citeproc-js and CSL styles power formatting. See [third-party notices](THIRD_PARTY_NOTICES.md) and `vendor/licenses/`. Metadata and PDF access depend on the respective sources’ availability and terms.
