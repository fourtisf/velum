# Vendored OpenZeppelin Contracts

- Version: **5.4.0** (from the npm package `@openzeppelin/contracts@5.4.0`; identical to GitHub tag
  `v5.4.0`, commit `c64a1edb67b6e3f4a15cca8909c9482ad33a02b0`, see `../VENDORED.md`)
- License: MIT, full text in `LICENSE` (the repository's license file at tag `v5.4.0`, Copyright (c) 2016-2025
  Zeppelin Group Ltd), SPDX header in every file
- Only these files are vendored, unmodified, because Velum may use OpenZeppelin only for
  ERC20 helpers and ReentrancyGuard:
  - token/ERC20/IERC20.sol, token/ERC20/utils/SafeERC20.sol
  - interfaces/IERC1363.sol, interfaces/IERC20.sol, interfaces/IERC165.sol
  - utils/introspection/IERC165.sol
  - utils/ReentrancyGuard.sol

To refresh: `npm pack @openzeppelin/contracts@5.4.0` and copy the same paths; take `LICENSE` from the
GitHub tag (the npm package has none).
