# Dark redesign verification

The interface now uses British English (`en-GB`), a near-black background, white headings and red accents. The connection indicator has been removed entirely. The footer includes © 2026 Citation Workflow and a developer website link to https://marronyao.com/.

## Design comparison

Reference: `dark-design-concept.png`, generated with the built-in Image Gen tool. Render: `dark-preview.png`, captured with the in-app browser at the reference's native viewport, 1435 × 1096. Mobile: `dark-mobile-preview.png`, captured at 390 × 844. Both reference and final desktop/mobile renders were inspected with `view_image`.

| Inspection | Result / intentional adjustment |
| --- | --- |
| Header and hierarchy | Red/white serif brand, no top-right status; central headline and DOI search preserved. |
| Copy | Headline, subtitle, panel headings and main actions match the design. Placeholders describe the actual DOI and metadata workflow. All application UI and server-generated messages use English. |
| Palette | Flat near-black surfaces, white text, red highlights; solid darker red primary buttons keep white button labels legible. No decorative gradients. |
| Typography | Serif display text and panel headings; sans-serif controls deliberately retained for form legibility. |
| Layout and spacing | Equal columns, thin borders, restrained corners, full-width copy button. Existing proper-name controls and citation notes make the implemented page taller than the concept. |
| Assets | Code-native controls and SVG document icon; no screenshot used as the UI. |
| Settings and footer | Real folder path and settings button replace the concept's invented dropdowns. Required copyright and developer link are present. Attribution names the actual citation dependencies. |
| Responsive layout | Columns stack at mobile width. No horizontal overflow; 390px viewport with 375px layout width after scrollbar. |

The requested visual direction and component hierarchy were faithfully checked against the concept. Remaining differences above are intentional functional/accessibility decisions, rather than missing interface elements; no clipping or overflow was found.

## Functional checks

- 8 Python tests and 6 JavaScript assertions pass.
- JavaScript and Python syntax checks pass.
- Confirmed the settings dialogue and invalid Windows-path feedback appear in English.
- Queried DOI `10.1371/journal.pbio.3000117` in the browser after removing the indicator; PMID 30753184 and PMC6372144 were returned, with English statuses and publisher label.
- APA reference generated and copied successfully as plain text.
- The developer link resolves in the markup to exactly `https://marronyao.com/`.
- DOM inspection confirmed `lang=en-GB`, no connection-indicator element, and no Chinese interface text in the rendered result.

This revision remains local. No GitHub publication was performed.
