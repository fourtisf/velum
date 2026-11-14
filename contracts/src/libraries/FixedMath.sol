// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

/// @title FixedMath
/// @notice Small rounding-aware integer helpers. Callers pick the rounding direction that favours
///         the protocol: amounts a user pays round up, amounts a user receives round down.
/// @dev Uses checked arithmetic: inputs are bounded by protocol limits (token supplies, 100-token
///      positions, prices below 1e30), so `a * b` overflowing reverts instead of wrapping.
library FixedMath {
    uint256 internal constant BPS = 10_000;
    uint256 internal constant WAD = 1e18;

    error CastOverflow();

    /// @notice uint256 -> int256, reverting instead of wrapping.
    function toInt(uint256 x) internal pure returns (int256) {
        if (x > uint256(type(int256).max)) revert CastOverflow();
        // forge-lint: disable-next-line(unsafe-typecast)
        return int256(x);
    }

    /// @notice int256 -> uint256 for values known to be non-negative, reverting otherwise.
    function toUint(int256 x) internal pure returns (uint256) {
        if (x < 0) revert CastOverflow();
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint256(x);
    }

    function mulDivDown(uint256 a, uint256 b, uint256 d) internal pure returns (uint256) {
        return (a * b) / d;
    }

    function mulDivUp(uint256 a, uint256 b, uint256 d) internal pure returns (uint256 r) {
        r = (a * b) / d;
        if (mulmod(a, b, d) != 0) r += 1;
    }

    /// @notice Signed `a * b / d`, rounded toward negative infinity.
    function mulDivFloorSigned(int256 a, uint256 b, uint256 d) internal pure returns (int256) {
        if (a >= 0) return toInt(mulDivDown(toUint(a), b, d));
        return -toInt(mulDivUp(toUint(-a), b, d));
    }

    /// @notice Signed `a * b / d`, rounded toward positive infinity.
    function mulDivCeilSigned(int256 a, uint256 b, uint256 d) internal pure returns (int256) {
        if (a >= 0) return toInt(mulDivUp(toUint(a), b, d));
        return -toInt(mulDivDown(toUint(-a), b, d));
    }

    function min(uint256 a, uint256 b) internal pure returns (uint256) {
        return a < b ? a : b;
    }

    /// @notice Integer square root (floor), Newton's method.
    function sqrt(uint256 x) internal pure returns (uint256 z) {
        if (x == 0) return 0;
        z = x;
        uint256 y = x / 2 + 1;
        while (y < z) {
            z = y;
            y = (x / y + y) / 2;
        }
    }
}
