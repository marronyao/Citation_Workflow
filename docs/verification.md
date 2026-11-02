# Local verification · 2026-11-02

- Browser: Codex in-app browser, using its native controls and screenshots; no Playwright fallback was needed.
- Reference: `design-concept.png`, generated with the built-in Image Gen tool from a brief specifying a white/green scholarly DOI tool, DOI input, paper/download column, citation column and Windows folder setting. No raster image is used as the application UI.
- Captured at the reference's native width and viewport (1505 × 1045); the implementation's full-page screenshot extends vertically for real workflow controls. Also checked 1440 × 1000 and 390 × 844. Mobile content width equals viewport width (390px).
- Used `view_image` to inspect the concept and final desktop/mobile screenshots together. Checked heading/copy order, two-column hierarchy, serif headings and control typography, white/green palette, panel borders/spacing, and responsive stacking. The white palette initially differed because the test browser injected Dark Reader; a per-page light-theme declaration fixed it.
- Functional additions to the reference are intentional: proper-name correction disclosure, source links/logs, editable full citation preview, connection errors, download-setting dialog, login dialog, source attribution. Real article titles/data replace the concept's illustrative article. No unrelated navigation or marketing sections were added. Above-the-fold title, subtitle and search CTA match the planned copy; live helper status reflects connection state.
- The design's hierarchy and visual direction were verified faithfully, with the functional additions and vertical expansion above. This is not a pixel-identical reproduction of the illustrative concept.

## Functional evidence

1. Real DOI URL `https://doi.org/10.1371/journal.pbio.3000117` normalized successfully; NCBI returned PMID **30753184**, PMCID **PMC6372144**, title **Reliable novelty: New should not trump true.**
2. Downloaded the real publisher PDF, **372,121 bytes**, verified `%PDF-` signature, to the specified Windows folder with a title-based filename. Repeated download produced a `(1)` filename, preserving the original.
3. Tested a quoted forward-slash Windows folder: `"D:/mGrocery/Codex/Citation Workflow/test-downloads"`.
4. Generated APA 7, Vancouver, Harvard, BibTeX and RIS through the UI. APA preview includes italic `PLoS Biology`; clipboard inspection confirmed a single **text/plain** item with no HTML.
5. Edited a scientific title containing DNA, Parkinson and mRNA; the citation and clipboard retained the correction.
6. Automated checks: **8 Python tests + 6 JavaScript assertions**, passing. Includes reference DOI isolation, path parsing, filename safety, login HTML rejection, PDF URL parsing, origin restrictions, failed-source login response, duplicate-download protection, biological sentence case and journal title case.

Not verified against live services: a working Sci-Hub mirror (none supplied), institution login, all publisher-specific download layouts, future GitHub Pages → localhost connectivity. Failed-source response and login destination were tested with controlled responses; an actual institutional login was not performed.
