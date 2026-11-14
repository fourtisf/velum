// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

interface IMakerBook {
    /// @notice Reserve `makerMargin` USDG of an offer's backing for a new position and move it to
    ///         the perps engine. Only the perps engine may call this.
    /// @return maker The offer's owner (the position's counterparty).
    /// @return openSpreadBps Spread applied to the entry price.
    /// @return closeSpreadBps Spread the maker commits to for closing, binding for the taker.
    function allocate(uint256 offerId, address market, uint256 fillSize, uint256 makerMargin)
        external
        returns (address maker, uint16 openSpreadBps, uint16 closeSpreadBps);
}
