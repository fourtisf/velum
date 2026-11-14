// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

/// @notice The public Chainlink AggregatorV3 read interface (only the calls Velum makes).
interface IAggregatorV3 {
    function decimals() external view returns (uint8);

    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}
