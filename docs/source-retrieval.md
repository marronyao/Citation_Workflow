# Cloud source retrieval and diagnostics

The cloud website searches original repositories, PMC and supported publisher sites. Sci-Hub, ResearchGate, Z-Library, Library Genesis and Anna's Archive belong to the legacy local helper and are not connected to the cloud service. Their absence from results is not evidence of a CAPTCHA, an outage or a missing copy. The cloud does not test whether these sites are reachable or can deliver a requested paper.

## Elsevier redirect fix

For `10.1016/j.cell.2012.11.001`, a live audit on 2 November 2026 found:

- Metadata lookup succeeded for *The Hairpin-type Tail-Anchored SNARE Syntaxin 17 Targets to Autophagosomes for Fusion with Endosomes/Lysosomes*.
- The deployed search returned `Official article: Unsupported source URL.`
- The DOI resolver redirected to `linkinghub.elsevier.com`, followed by an HTML refresh toward `cell.com`. Both exact hosts were absent from the cloud allowlist.
- Europe PMC reported no PMC/Europe PMC full text or PDF for this DOI at audit time. This says nothing about copies on other services.

The backend now permits these two official hosts, follows bounded HTML refresh redirects with the same URL validation as HTTP redirects, and resolves relative PDF URLs against the final page URL. Publisher landing pages are also checked after registered PDF candidates fail. Every redirect remains subject to the source allowlist; scripts and verification challenges are not executed.

Search history now distinguishes an empty PMC result, an unsupported host, a publisher response without a PDF link, a verification page, HTTP access denial and a source rate limit. Unconnected sources are explicitly labelled **Not searched** when retrieval fails. A corrected resolver path does not guarantee that a subscription publisher will return a PDF to the cloud service.

Regression tests cover an Elsevier-style HTTP/HTML redirect chain, relative PDF discovery after a failed candidate, blocked redirects to an unapproved host, and accurate verification/unconnected-source diagnostics.
