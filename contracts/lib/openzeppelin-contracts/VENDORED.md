# Vendored OpenZeppelin Contracts

- Version: **5.4.0** (from the npm package `@openzeppelin/contracts@5.4.0`)
- License: MIT (SPDX header in every file), Copyright (c) OpenZeppelin
- Only these files are vendored, unmodified, because Velum may use OpenZeppelin only for
  ERC20 helpers and ReentrancyGuard:
  - token/ERC20/IERC20.sol, token/ERC20/utils/SafeERC20.sol
  - interfaces/IERC1363.sol, interfaces/IERC20.sol, interfaces/IERC165.sol
  - utils/introspection/IERC165.sol
  - utils/ReentrancyGuard.sol

To refresh: `npm pack @openzeppelin/contracts@5.4.0` and copy the same paths.
