Self-hosted fonts (latin subset, variable woff2), so builds never fetch from Google Fonts (a failed fetch used to
fail the production build on the VPS) and visitors never contact a third party for fonts.

| File | Family | Source | Licence |
|---|---|---|---|
| Inter-latin.woff2 | Inter (wght 400–600 used) | fonts.gstatic.com/s/inter/v20 | SIL OFL 1.1 (OFL-Inter.txt) |
| InterTight-latin.woff2 | Inter Tight (wght 500–600 used) | fonts.gstatic.com/s/intertight/v9 | SIL OFL 1.1 (OFL-InterTight.txt) |

These are the exact files next/font/google downloaded before (same subset and version).
