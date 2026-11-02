# Citation Workflow

Find a paper by DOI, save its PDF and generate a reference — in one workspace.

Citation Workflow is a research tool for biological literature, with a dark interface, PubMed lookup and editable references. The website runs on GitHub Pages; a small Windows companion handles full-text retrieval and saves PDFs to your chosen folder.

**[Open Citation Workflow](https://marronyao.github.io/Citation_Workflow/)** · **[Developer’s website](https://marronyao.com/)**

![Citation Workflow dark interface](docs/dark-preview.png)

## Features

- Accepts a DOI on its own, a `doi:` prefix or a full `https://doi.org/` link.
- Searches PubMed and verifies an exact DOI match, with DOI registration metadata as a fallback.
- Tries third-party PDF databases first: PubMed Central, then automatically discovered Sci-Hub mirrors. Offers publisher links only after the database search cannot retrieve a PDF.
- Saves verified PDFs using the original article title, replacing unsupported Windows filename characters. Duplicate downloads receive a numeric suffix rather than overwriting an existing file.
- Generates **APA 7, Vancouver, Harvard, BibTeX and RIS** references.
- Applies APA sentence case to article titles and title case to journal names, with editable titles and a list of proper nouns to preserve.
- Shows a formatted preview, including italics, and copies the reference as plain text.
- Uses British English throughout the interface.

## Getting started on Windows

### 1. Download the project

Choose **Code → Download ZIP** on this repository and extract the archive, or clone it:

```powershell
git clone https://github.com/marronyao/Citation_Workflow.git
cd Citation_Workflow
```

### 2. Start the companion

Install **Python 3.10 or later**, with Python available on your PATH. Chrome or Edge is recommended. No third-party Python packages or Node.js installation are needed to use the tool.

Double-click **`start.bat`**. Keep the companion’s command window open while using the website. A local copy opens at **http://127.0.0.1:8765/**; you can also use the [GitHub Pages website](https://marronyao.github.io/Citation_Workflow/) while the companion is running.

To start it from a terminal:

```powershell
python server.py --origin https://marronyao.github.io --open-browser
```

If your browser asks for permission to connect to the local network, allow it for Citation Workflow. If the hosted page cannot reach the companion, use the local page instead.

### 3. Find and save a paper

1. Select **Set download folder** above the DOI search and enter an existing Windows folder.
2. Enter a DOI or DOI link and select **Find paper**.
3. Review the paper details and reference. Downloads start automatically by default; turn this off in settings if you prefer to select **Download PDF** yourself.
4. Choose a reference style, check the title’s capitalisation and select **Copy citation**.

Accepted folder examples:

```text
D:\Papers
D:/Papers
"D:/Research papers"
```

Only absolute Windows drive paths are supported. The folder must already exist; UNC network paths are not currently supported.

## Full-text access

The companion checks PubMed Central first, then searches Google (with DuckDuckGo as a fallback) for Sci-Hub mirror candidates. If plain search pages contain no usable links, it retries in an isolated, hidden Chrome or Edge session, without using your signed-in browser profile. It tries up to three distinct HTTPS mirror domains and checks each retrieved file for a PDF header. No manual mirror setting is needed. Search results do not guarantee that a mirror is working; blocked searches, unavailable mirrors and failed retrievals appear in the source search history.

Database adapters are registered in `DATABASE_PROVIDERS` in `server.py`, allowing more sources to be added in order. A successful download stops the search before later adapters run. The publisher is not used as an automatic PDF source.

If the databases cannot retrieve a PDF, a dialogue offers the DOI resolver, a publisher URL from the article metadata when available, and a Google search link. The DOI resolver redirects to the registered publisher. The user chooses which link to open and can sign in through their institution to complete the download there. The companion does not share your browser’s sign-in session or handle CAPTCHA and JavaScript challenges. Some publisher layouts will require a manual download even when full text is available.

References can still be generated when the PDF is unavailable. Downloads are limited to 80 MB and checked for a PDF header before saving.

## Reference formatting

APA 7, Vancouver and Harvard are rendered using Citation.js and citeproc-js. BibTeX and RIS support reference-manager workflows.

APA article titles use sentence case, preserving abbreviations and mixed-case terms such as DNA and mRNA. Automatic case conversion cannot reliably identify every person, place, species or gene name. Add terms under **APA capitalisation & proper nouns**, or edit the title directly. Titles supplied entirely in capitals need particular care.

The formatted preview preserves journal and volume italics. **Copy citation** copies only plain text. Editing the plain-text box changes what is copied; changing the style or article title regenerates its contents. Paper titles and other bibliographic metadata remain in their original language.

## How the website and companion work together

```text
GitHub Pages / local webpage
          │
          │ DOI lookup and download requests
          ▼
Windows companion at 127.0.0.1:8765
          ├── PubMed / DOI metadata
          ├── Full-text and PDF sources
          └── Your selected Windows folder
```

GitHub Pages hosts the static interface and cannot run the Python companion or write directly to a Windows folder. The companion must run on the computer where PDFs will be saved.

The companion listens only on the loopback interface. It accepts its local origin and, when started with the command above, `https://marronyao.github.io`. API requests that initiate lookups or downloads require a random session token. The local server exposes only the frontend assets, rather than arbitrary local files.

Folder and automatic-download preferences are stored in the browser’s local storage. Folder paths are sent to the local companion for saving; the configured folder is not sent to publication metadata or full-text services. DOI queries and download requests are sent to the relevant external services.

## Development

Use Node.js 22 or later and Python 3.10 or later on Windows:

```powershell
npm ci
npm run build
npm test
```

The bundled citation engine is committed so the application works without installing Node.js. Rebuild it after changing `citation-entry.js` or its dependencies.

| File | Purpose |
| --- | --- |
| `index.html`, `styles.css`, `app.js` | Static interface |
| `server.py`, `start.bat` | Windows companion and launcher |
| `citation-entry.js`, `vendor/citation.js` | Citation engine entry point and browser bundle |
| `tests/` | DOI, path, download and formatting checks |
| `.github/workflows/pages.yml` | Checks and GitHub Pages deployment |

The deployment workflow checks the project on Windows and publishes only frontend assets and dependency notices to Pages. It excludes downloaded papers, local settings, Python source and development files from the website artifact. The project source remains available in this public repository.

## Sources and acknowledgements

- [NCBI E-Utilities](https://www.ncbi.nlm.nih.gov/books/NBK25499/) for PubMed records.
- [DOI content negotiation](https://www.crossref.org/documentation/retrieve-metadata/content-negotiation/) for bibliographic metadata.
- [Citation.js](https://citation.js.org/), [citeproc-js by Frank Bennett](https://github.com/Juris-M/citeproc-js) and [Citation Style Language styles](https://github.com/citation-style-language/styles) for reference rendering.

Original project code is available under the [MIT licence](LICENSE). Third-party components retain their own licences. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and [vendor/licenses](vendor/licenses) for attribution and licence information.

© 2026 Citation Workflow · Developed by [Marron Zihao Yao](https://marronyao.com/)
