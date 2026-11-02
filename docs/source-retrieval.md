# Cloud source retrieval and diagnostics

The cloud website searches original repositories, PMC and supported publisher sites, followed by configured Sci-Hub, Z-Library and Library Genesis endpoints for records with a DOI. ResearchGate and Anna's Archive remain unconnected. The search history describes actual requests and failures; absence of a PDF does not by itself prove that the requested paper is absent from a service.

## Third-party adapters

`cloud/third-party.mjs` contains the source-specific DOI search paths and a fixed list of eligible public hosts. Each provider has a 20-second budget within a 60-second total fallback budget. Requests use ordinary HTTPS without credentials or browser sessions. HTML records must identify the DOI or a matching title before their embedded/download PDF candidates are accepted. A conflicting `citation_doi` is rejected. PDF signatures are verified by the existing bounded cloud download pipeline; URLs and redirects remain restricted to approved hosts.

Each provider records its attempts separately. Challenge pages, login, access denial, timeout and no matching record are distinct outcomes. Direct browser links allow the user to open a configured source themselves when automation fails. This does not transfer the user's login/verification state to the Worker or guarantee a subsequent automatic download. The cloud does not solve challenges or disable TLS validation. These are connected adapters, not a promise that every source is currently reachable or offers unauthenticated downloads.

Regression coverage includes DOI/title matching, conflicting DOI rejection, challenge/login detection, requests to all configured providers, blocked unapproved download hosts and a matching source PDF receiving a signed cloud download ticket.

No Release is created by an ordinary push. Publishing a Release requires a manual Pages workflow run with `publish_release` explicitly enabled.

## Elsevier redirect fix

For `10.1016/j.cell.2012.11.001`, a live audit on 2 November 2026 found:

- Metadata lookup succeeded for *The Hairpin-type Tail-Anchored SNARE Syntaxin 17 Targets to Autophagosomes for Fusion with Endosomes/Lysosomes*.
- The deployed search returned `Official article: Unsupported source URL.`
- The DOI resolver redirected to `linkinghub.elsevier.com`, followed by an HTML refresh toward `cell.com`. Both exact hosts were absent from the cloud allowlist.
- Europe PMC reported no PMC/Europe PMC full text or PDF for this DOI at audit time. This says nothing about copies on other services.

The backend now permits these two official hosts, follows bounded HTML refresh redirects with the same URL validation as HTTP redirects, and resolves relative PDF URLs against the final page URL. Publisher landing pages are also checked after registered PDF candidates fail. Every redirect remains subject to the source allowlist; scripts and verification challenges are not executed.

Search history distinguishes an empty PMC result, an unsupported host, a publisher response without a PDF link, a verification page, HTTP access denial and a source rate limit. Unconnected sources are explicitly labelled **Not searched** when retrieval fails. A corrected resolver path does not guarantee that a subscription publisher will return a PDF to the cloud service. The initial audit described below predates the third-party adapter deployment.

Regression tests cover an Elsevier-style HTTP/HTML redirect chain, relative PDF discovery after a failed candidate, blocked redirects to an unapproved host, and accurate verification/unconnected-source diagnostics.
