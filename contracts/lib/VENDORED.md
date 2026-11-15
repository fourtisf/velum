# Vendored libraries

Velum's first-party Solidity (`src/`, `script/`, `test/`) is proprietary and marked
`SPDX-License-Identifier: UNLICENSED`. The two libraries below are third-party code, vendored
unmodified under their own open-source licenses, which travel with them in this directory.

| Library | Version (tag) | Upstream commit | License | Used by | Files |
|---|---|---|---|---|---|
| OpenZeppelin Contracts | 5.4.0 (`v5.4.0`) | `c64a1edb67b6e3f4a15cca8909c9482ad33a02b0` | MIT (`openzeppelin-contracts/LICENSE`, and the SPDX header in every file) | production contracts | 7 files, listed in `openzeppelin-contracts/VENDORED.md` |
| forge-std | 1.17.0 (`v1.17.0`) | `f3dae6e6ee381f25eb6a246f7da9b85c91a68219` | MIT or Apache-2.0, at your option (`forge-std/LICENSE-MIT`, `forge-std/LICENSE-APACHE`) | tests and the deploy script only (never deployed) | all 32 files of `src/` |

## Byte-identical to upstream

Checked on 2026-11-15 by cloning each tag from GitHub (`github.com/OpenZeppelin/openzeppelin-contracts`,
`github.com/foundry-rs/forge-std`; `git ls-remote` resolves the tags to the commits above) and comparing every
vendored file with `cmp`:

- OpenZeppelin: the 7 files under `openzeppelin-contracts/contracts/` are identical to the same paths at `v5.4.0`
  and in the npm package `@openzeppelin/contracts@5.4.0` (from which they were first copied). `LICENSE` is the
  repository's license file at `v5.4.0`, byte for byte (the npm package carries no license file, only the SPDX
  headers).
- forge-std: the 32 files under `forge-std/src/` (the whole upstream `src/`, nothing more, nothing less) and both
  license files are identical to `v1.17.0`.

To re-check, clone the tag next to this repository and run `cmp` (or `diff -r`) over the same paths. Do not edit
vendored files: upgrade by copying the same paths from a new tag and updating this table.
