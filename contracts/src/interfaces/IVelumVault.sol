// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

/// @notice What Velum modules (spot pools, maker book, perps) need from the vault.
interface IVelumVault {
    function balanceOf(address account, address token) external view returns (uint256);

    /// @notice Move an internal balance. Callable only by a registered module; `from` must be the
    ///         module itself or an account that approved that module.
    function transferInternal(address token, address from, address to, uint256 amount) external;
}
