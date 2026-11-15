// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {VelumVault} from "../../src/VelumVault.sol";
import {OracleAdapter} from "../../src/OracleAdapter.sol";
import {SpotPools} from "../../src/SpotPools.sol";
import {MakerBook} from "../../src/MakerBook.sol";
import {PerpsMarkets} from "../../src/PerpsMarkets.sol";
import {PerpsBase} from "../../src/perps/PerpsBase.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {MockAggregator} from "../mocks/MockAggregator.sol";
import {Vm} from "forge-std/Vm.sol";

/// @notice Drives random but valid-ish protocol usage for the invariant suite and keeps ghost totals. With a guarded
///         vault it also checks every deposit, approval and withdrawal against an independent model of the launch
///         guard and drives the guard admin (allowlisting, cap raises, handovers, `openToPublic`, `liftCaps`).
contract Handler is Test {
    VelumVault public vault;
    OracleAdapter public oracle;
    SpotPools public pools;
    MakerBook public book;
    PerpsMarkets public perps;
    MockERC20 public usdg;
    MockERC20[2] public stocks;
    address public relayer;
    address public guardian;
    /// @dev The oracle's L2 sequencer-uptime feed (final audit: the suites had none).
    MockAggregator public sequencerFeed;
    uint256 public sequencerDowns;
    uint256 public sequencerGraces;
    /// @dev Liquidations reached through close (taker as liquidator) and through settleForcedExit.
    uint256 public closeLiquidations;
    uint256 public forcedExitLiquidations;

    address[] public actors;
    address public liquidator = makeAddr("inv-liquidator");
    uint256[] public positionIds;
    uint256[] public offerIds;

    mapping(address token => uint256) public deposited;
    mapping(address token => uint256) public withdrawn;
    bool public liquidationOverpaid;
    /// @dev A liquidation paid more than the pool plus the capped keeper top-up (cover must be deferred).
    bool public immediateCoverPaid;
    /// @dev An epoch's cap was not 10% of the fund at its first draw, or its draws exceeded the cap.
    bool public coverOverCap;
    /// @dev A guardian action moved funds.
    bool public guardianMovedFunds;
    uint256 public coverClaimsPaid;
    uint256 public gaps;
    uint256 public closeOnlyToggles;

    // cover claims seen, per epoch
    uint256[] public claimEpochs;
    mapping(uint256 epoch => bool) internal _epochSeen;
    mapping(uint256 epoch => address[]) internal _claimants;
    mapping(uint256 epoch => mapping(address account => bool)) internal _claimantSeen;
    uint256 public liquidations;
    uint256 public closes;
    uint256 public opens;
    uint256 public forcedExits;
    uint256 public openAttempts;
    uint256 public openFailures;
    bytes4 public lastOpenError;

    uint256[2] public price = [uint256(391.65e18), uint256(233.4e18)];

    // launch guard (contracts/README.md, Guarded launch); inert when the vault is unguarded
    /// @dev A deposit the guard should have refused went through (an address outside an active allowlist, or above
    ///      an active cap), or an address outside an active allowlist granted a module approval.
    bool public guardBypassed;
    /// @dev A deposit or approval the guard should have let through was refused, one was refused with a non-guard error,
    ///      or after an admin action the admin role did not match the guard state (an admin exactly while guarded).
    bool public guardMisfired;
    /// @dev A valid withdrawal reverted, or an exit (close, forced exit, liquidity removal) reverted with a guard error.
    bool public exitBlocked;
    /// @dev A guard-admin action changed a balance, a reserve, a margin, the fund or an offer's backing.
    bool public guardAdminMovedFunds;
    uint256 public guardRefusals;
    uint256 public guardAdminActions;
    /// @dev Independent copy of the vault's `netDeposited`, kept while caps are active.
    mapping(address account => mapping(address token => uint256)) public ghostNet;

    constructor(
        VelumVault vault_,
        OracleAdapter oracle_,
        SpotPools pools_,
        MakerBook book_,
        PerpsMarkets perps_,
        MockERC20 usdg_,
        MockERC20 s0,
        MockERC20 s1,
        address relayer_,
        address guardian_,
        MockAggregator sequencerFeed_
    ) {
        sequencerFeed = sequencerFeed_;
        vault = vault_;
        oracle = oracle_;
        pools = pools_;
        book = book_;
        perps = perps_;
        usdg = usdg_;
        stocks[0] = s0;
        stocks[1] = s1;
        relayer = relayer_;
        guardian = guardian_;
        // With a launch guard, actors 0-3 start allowlisted and actor 4 does not (it can be added later, or the guard
        // admin opens the vault to the public); only allowlisted actors can approve the modules.
        address admin = vault_.guardAdmin();
        for (uint256 i; i < 5; ++i) {
            address a = makeAddr(string(abi.encodePacked("actor", vm.toString(i))));
            actors.push(a);
            vm.deal(a, 10 ether);
            if (admin != address(0) && i < 4) {
                vm.prank(admin);
                vault.addToAllowlist(_one(a));
            }
            vm.startPrank(a);
            usdg.approve(address(vault), type(uint256).max);
            s0.approve(address(vault), type(uint256).max);
            s1.approve(address(vault), type(uint256).max);
            vm.stopPrank();
            if (vault.isAllowed(a)) _approveModules(a);
        }
    }

    function _one(address a) internal pure returns (address[] memory l) {
        l = new address[](1);
        l[0] = a;
    }

    function _approveModules(address a) internal {
        vm.startPrank(a);
        vault.setApproval(address(pools), true);
        vault.setApproval(address(book), true);
        vault.setApproval(address(perps), true);
        vm.stopPrank();
    }

    // ------------------------------------------------------------ helpers

    function actorCount() external view returns (uint256) {
        return actors.length;
    }

    function positionCount() external view returns (uint256) {
        return positionIds.length;
    }

    function claimEpochCount() external view returns (uint256) {
        return claimEpochs.length;
    }

    function claimantCount(uint256 epoch) external view returns (uint256) {
        return _claimants[epoch].length;
    }

    function claimant(uint256 epoch, uint256 i) external view returns (address) {
        return _claimants[epoch][i];
    }

    /// @dev Remember any cover claim a settlement just filed for either side of position `p`, and check the
    ///      epoch's cap: fixed at 10% of the fund at the first draw (`capWasSet` = before the settlement),
    ///      never exceeded by top-ups plus reserved cover (audit R2-02, R2-03).
    function _trackClaims(PerpsBase.Position memory p, bool capWasSet) internal {
        uint256 e = perps.currentCoverEpoch();
        _trackClaimant(e, p.taker);
        _trackClaimant(e, p.maker);
        (,, uint256 budget,, uint256 cap, uint256 drawn, bool capSet,) = perps.coverEpochs(e);
        if (drawn > cap || budget > drawn) coverOverCap = true;
        // On the first draw everything drawn came from this settlement, so the fund then was insurance + drawn.
        if (capSet && !capWasSet && cap != ((perps.insurance() + drawn) * perps.COVER_CAP_BPS()) / 10_000) {
            coverOverCap = true;
        }
    }

    function _capSet() internal view returns (bool capSet) {
        (,,,,,, capSet,) = perps.coverEpochs(perps.currentCoverEpoch());
    }

    function _trackClaimant(uint256 e, address a) internal {
        if (perps.coverClaims(e, a) == 0 || _claimantSeen[e][a]) return;
        _claimantSeen[e][a] = true;
        _claimants[e].push(a);
        if (!_epochSeen[e]) {
            _epochSeen[e] = true;
            claimEpochs.push(e);
        }
    }

    function _actor(uint256 seed) internal view returns (address) {
        return actors[seed % actors.length];
    }

    function _token(uint256 seed) internal view returns (MockERC20) {
        uint256 k = seed % 3;
        return k == 0 ? usdg : stocks[k - 1];
    }

    /// @dev Keep both prices fresh; each push needs a new second.
    function refreshPrices() public {
        vm.warp(block.timestamp + 1);
        address[] memory t = new address[](2);
        uint256[] memory v = new uint256[](2);
        t[0] = address(stocks[0]);
        t[1] = address(stocks[1]);
        v[0] = price[0];
        v[1] = price[1];
        vm.prank(relayer);
        oracle.pushPrices(t, v);
    }

    // ------------------------------------------------------------ vault

    function deposit(uint256 actorSeed, uint256 tokenSeed, uint256 amount) external {
        address a = _actor(actorSeed);
        MockERC20 t = tokenSeed % 2 == 0 ? usdg : _token(tokenSeed);
        amount = bound(amount, t == usdg ? 100e6 : 1e15, t == usdg ? 200_000e6 : 500e18);
        _deposit(a, a, t, amount);
    }

    /// @dev Deposit credited to another actor (or the keeper): with an active allowlist both must be on it, and the
    ///      credited account's cap applies.
    function depositFor(uint256 fromSeed, uint256 toSeed, uint256 tokenSeed, uint256 amount) external {
        address from = _actor(fromSeed);
        address to = toSeed % 6 == 5 ? liquidator : _actor(toSeed);
        MockERC20 t = _token(tokenSeed);
        amount = bound(amount, t == usdg ? 100e6 : 1e15, t == usdg ? 200_000e6 : 500e18);
        _deposit(from, to, t, amount);
    }

    /// @dev Checks the launch guard's decision against an independent model (allowlist flags, ghost net deposits).
    function _deposit(address from, address to, MockERC20 t, uint256 amount) internal {
        t.mint(from, amount);
        bool refuse = _guardRefuses(from, to, address(t), amount);
        vm.prank(from);
        try vault.deposit(address(t), amount, to) returns (uint256 got) {
            deposited[address(t)] += got;
            if (refuse) guardBypassed = true;
            if (vault.capsActive()) ghostNet[to][address(t)] += got;
        } catch (bytes memory err) {
            guardRefusals++;
            if (!refuse || !_isGuardError(err)) guardMisfired = true;
        }
    }

    function _guardRefuses(address from, address to, address t, uint256 amount) internal view returns (bool) {
        if (vault.allowlistActive() && !(vault.isAllowlisted(from) && vault.isAllowlisted(to))) return true;
        if (!vault.capsActive()) return false;
        return ghostNet[to][t] + amount > vault.accountCap(t) || vault.totalInternal(t) + amount > vault.globalCap(t);
    }

    function _isGuardError(bytes memory err) internal pure returns (bool) {
        bytes4 sel = bytes4(err);
        return sel == VelumVault.NotAllowlisted.selector || sel == VelumVault.AccountCapExceeded.selector
            || sel == VelumVault.GlobalCapExceeded.selector;
    }

    /// @dev A withdrawal of at most the balance, to the actor itself, must always go through.
    function withdraw(uint256 actorSeed, uint256 tokenSeed, uint256 amount) external {
        address a = _actor(actorSeed);
        MockERC20 t = _token(tokenSeed);
        uint256 bal = vault.balanceOf(a, address(t));
        if (bal == 0) return;
        amount = bound(amount, 1, bal);
        _withdraw(a, t, amount);
    }

    function _withdraw(address a, MockERC20 t, uint256 amount) internal {
        vm.prank(a);
        try vault.withdraw(address(t), amount, a) {
            withdrawn[address(t)] += amount;
            if (vault.capsActive()) {
                uint256 g = ghostNet[a][address(t)];
                ghostNet[a][address(t)] = g > amount ? g - amount : 0;
            }
        } catch {
            exitBlocked = true;
        }
    }

    // ------------------------------------------------------------ spot

    function addLiquidity(uint256 actorSeed, uint256 stockSeed, uint256 s, uint256 u) external {
        address a = _actor(actorSeed);
        MockERC20 st = stocks[stockSeed % 2];
        uint256 sb = vault.balanceOf(a, address(st));
        uint256 ub = vault.balanceOf(a, address(usdg));
        if (sb < 1e15 || ub < 1e6) return;
        s = bound(s, 1e15, sb);
        u = bound(u, 1e6, ub);
        vm.prank(a);
        try pools.addLiquidity(address(st), s, u, 1, block.timestamp) {} catch {}
    }

    function removeLiquidity(uint256 actorSeed, uint256 stockSeed, uint256 pct) external {
        address a = _actor(actorSeed);
        address st = address(stocks[stockSeed % 2]);
        uint256 sh = pools.sharesOf(st, a);
        if (sh == 0) return;
        uint256 amount = (sh * bound(pct, 1, 100)) / 100;
        if (amount == 0) return;
        vm.prank(a);
        try pools.removeLiquidity(st, amount, 1, 1, block.timestamp) {}
        catch (bytes memory err) {
            if (_isGuardError(err)) exitBlocked = true;
        }
    }

    function swap(uint256 actorSeed, uint256 inSeed, uint256 outSeed, uint256 amount) external {
        address a = _actor(actorSeed);
        MockERC20 tin = _token(inSeed);
        MockERC20 tout = _token(outSeed);
        if (tin == tout) return;
        uint256 bal = vault.balanceOf(a, address(tin));
        if (bal == 0) return;
        amount = bound(amount, 1, bal);
        vm.prank(a);
        try pools.swap(address(tin), address(tout), amount, 1, block.timestamp) {} catch {}
    }

    // ------------------------------------------------------------ makers

    function postOffer(uint256 actorSeed, uint256 stockSeed, uint256 backing, uint256 fillPct, uint16 o, uint16 c)
        external
    {
        address a = _actor(actorSeed);
        uint256 bal = vault.balanceOf(a, address(usdg));
        if (bal < 20e6) return;
        backing = bound(backing, 10e6, bal / 2); // keep funds for trading too
        uint256 largest = (backing * bound(fillPct, 1, 100)) / 100;
        if (largest == 0) largest = backing;
        vm.prank(a);
        uint256 id = book.postOffer(
            address(stocks[stockSeed % 2]),
            backing,
            largest,
            uint16(bound(o, 2, 500)),
            uint16(bound(c, 0, 500)),
            uint64(block.timestamp + 365 days)
        );
        offerIds.push(id);
    }

    function withdrawOffer(uint256 idx) external {
        if (offerIds.length == 0) return;
        uint256 id = offerIds[idx % offerIds.length];
        (address maker,,,,,,, bool active) = book.offers(id);
        if (!active) return;
        vm.prank(maker);
        book.withdrawOffer(id);
    }

    // ------------------------------------------------------------ perps

    function openPosition(uint256 actorSeed, uint256 offerIdx, bool isLong, uint256 size, uint8 lev) external {
        if (offerIds.length == 0) return;
        uint256 id = offerIds[offerIdx % offerIds.length];
        (address maker, address market,,,,, uint64 expiry, bool active) = book.offers(id);
        if (!active || block.timestamp >= expiry) return;
        // first actor (from the seed) who is not the maker and holds some USDG
        address a;
        for (uint256 i; i < actors.length; ++i) {
            address c = _actor(actorSeed + i);
            if (c != maker && vault.balanceOf(c, address(usdg)) >= 20e6) {
                a = c;
                break;
            }
        }
        if (a == address(0)) return;
        lev = uint8(bound(lev, 2, 10));
        uint256 maxSize = _maxSize(id, a, lev, market);
        if (maxSize < 10e6) return; // minimum position size (audit F-10)
        size = bound(size, 10e6, maxSize);
        openAttempts++;
        _tryOpen(a, id, market, isLong, size, lev);
    }

    /// @dev The widest non-zero price limit for the side (IA-10: zero is refused).
    function _tryOpen(address a, uint256 id, address market, bool isLong, uint256 size, uint8 lev) internal {
        uint256 limit = isLong ? type(uint256).max : 1;
        vm.prank(a);
        try perps.open(id, market, isLong, size, lev, limit) returns (uint256 pid) {
            positionIds.push(pid);
            opens++;
        } catch (bytes memory err) {
            openFailures++;
            lastOpenError = bytes4(err);
        }
    }

    /// @dev Largest size inside every limit: balance, largest fill, backing, ~99 tokens.
    function _maxSize(uint256 id, address a, uint8 lev, address market) internal view returns (uint256 maxSize) {
        (,, uint256 backing, uint256 largest,,,,) = book.offers(id);
        maxSize = (vault.balanceOf(a, address(usdg)) * lev * 99) / 200;
        if (largest < maxSize) maxSize = largest;
        if (backing * 5 < maxSize) maxSize = backing * 5;
        uint256 k = market == address(stocks[0]) ? 0 : 1;
        uint256 qtyCap = (price[k] * 99) / 1e12; // ~99 tokens of notional in USDG base units
        if (qtyCap < maxSize) maxSize = qtyCap;
    }

    /// @dev USDG balances of everyone a settlement can pay, and the fund, before it.
    struct Payees {
        uint256 taker;
        uint256 maker;
        uint256 caller;
        uint256 insurance;
    }

    function _payees(PerpsBase.Position memory p, address caller) internal view returns (Payees memory b) {
        b = Payees(
            vault.balanceOf(p.taker, address(usdg)),
            vault.balanceOf(p.maker, address(usdg)),
            caller == p.taker ? 0 : vault.balanceOf(caller, address(usdg)),
            perps.insurance()
        );
    }

    /// @dev Invariant 3 for any settlement (liquidate, close, settleForcedExit): what left the position's pool to the
    ///      taker, maker and caller is at most the pool plus the fund, and at most the pool plus the capped keeper
    ///      top-up (cover is never paid at settlement). Counts the Liquidated events in `logs`.
    function _checkPayout(PerpsBase.Position memory p, address caller, Payees memory b, Vm.Log[] memory logs)
        internal
        returns (bool liquidated)
    {
        uint256 pool = p.takerMargin + p.makerMargin;
        uint256 paid =
            (vault.balanceOf(p.taker, address(usdg)) - b.taker) + (vault.balanceOf(p.maker, address(usdg)) - b.maker);
        if (caller != p.taker) paid += vault.balanceOf(caller, address(usdg)) - b.caller;
        if (paid > pool + b.insurance) liquidationOverpaid = true;
        if (paid > pool + perps.keeperRewardCap()) immediateCoverPaid = true;
        bytes32 sig = PerpsBase.Liquidated.selector;
        for (uint256 j; j < logs.length; ++j) {
            if (logs[j].emitter == address(perps) && logs[j].topics[0] == sig) liquidated = true;
        }
    }

    function closePosition(uint256 idx) external {
        if (positionIds.length == 0) return;
        uint256 id = positionIds[idx % positionIds.length];
        PerpsBase.Position memory p = perps.getPosition(id);
        if (!p.open) return;
        bool capWasSet = _capSet();
        Payees memory b = _payees(p, p.taker);
        vm.recordLogs();
        vm.prank(p.taker);
        try perps.close(id, p.isLong ? 1 : type(uint256).max) {
            closes++;
            if (_checkPayout(p, p.taker, b, vm.getRecordedLogs())) closeLiquidations++;
            _trackClaims(p, capWasSet);
        } catch (bytes memory err) {
            if (_isGuardError(err)) exitBlocked = true;
        }
    }

    /// @dev The taker of the first liquidatable position from `idx` closes it: the close settles as a liquidation
    ///      with the taker as liquidator (F-12), or as a plain close when the sequencer rule forbids the liquidation.
    function closeLiquidatable(uint256 idx) external {
        uint256 n = positionIds.length;
        if (n == 0) return;
        uint256 start = idx % n;
        for (uint256 j; j < n; ++j) {
            uint256 id = positionIds[(start + j) % n];
            PerpsBase.Position memory p = perps.getPosition(id);
            if (!p.open) continue;
            try perps.isLiquidatable(id) returns (bool yes) {
                if (!yes) continue;
            } catch {
                continue;
            }
            this.closePosition((start + j) % n);
            return;
        }
    }

    function addMargin(uint256 idx, uint256 amount, bool makerSide) external {
        if (positionIds.length == 0) return;
        uint256 id = positionIds[idx % positionIds.length];
        PerpsBase.Position memory p = perps.getPosition(id);
        if (!p.open) return;
        address who = makerSide ? p.maker : p.taker;
        uint256 bal = vault.balanceOf(who, address(usdg));
        if (bal == 0) return;
        vm.prank(who);
        perps.addMargin(id, bound(amount, 1, bal));
    }

    /// @dev Keeper-style: liquidate the first liquidatable position found from `idx`.
    function liquidate(uint256 idx) external {
        uint256 n = positionIds.length;
        for (uint256 j; j < n; ++j) {
            uint256 id = positionIds[(idx + j) % n];
            PerpsBase.Position memory p = perps.getPosition(id);
            if (!p.open) continue;
            try perps.isLiquidatable(id) returns (bool yes) {
                if (!yes) continue;
            } catch {
                continue;
            }
            _liquidate(id, p);
            return;
        }
    }

    function _liquidate(uint256 id, PerpsBase.Position memory p) internal {
        bool capWasSet = _capSet();
        Payees memory b = _payees(p, liquidator);
        vm.prank(liquidator);
        perps.liquidate(id);
        liquidations++;
        _checkPayout(p, liquidator, b, new Vm.Log[](0));
        _trackClaims(p, capWasSet);
    }

    /// @dev Settle `id`'s matured forced exit as the keeper, checking the payout like any liquidation (a liquidatable
    ///      position settles as one, F-08).
    function _settleForcedExit(uint256 id) internal returns (bool settled) {
        PerpsBase.Position memory p = perps.getPosition(id);
        bool capWasSet = _capSet();
        Payees memory b = _payees(p, liquidator);
        vm.recordLogs();
        vm.prank(liquidator); // a liquidatable position settles as a liquidation: reward to the keeper
        try perps.settleForcedExit(id) {
            settled = true;
            forcedExits++;
            if (_checkPayout(p, liquidator, b, vm.getRecordedLogs())) forcedExitLiquidations++;
            _trackClaims(p, capWasSet);
        } catch (bytes memory err) {
            if (_isGuardError(err)) exitBlocked = true;
        }
    }

    function requestForcedExit(uint256 idx, bool byMaker) external {
        if (positionIds.length == 0) return;
        uint256 id = positionIds[idx % positionIds.length];
        PerpsBase.Position memory p = perps.getPosition(id);
        if (!p.open || p.exitRequestedAt != 0) return;
        vm.prank(byMaker ? p.maker : p.taker);
        perps.requestForcedExit{value: 0.001 ether}(id);
    }

    /// @dev Jump a week, refresh prices and settle every due forced exit.
    function settleForcedExits() external {
        vm.warp(block.timestamp + 7 days);
        refreshPrices();
        for (uint256 i; i < positionIds.length; ++i) {
            PerpsBase.Position memory p = perps.getPosition(positionIds[i]);
            if (!p.open || p.exitRequestedAt == 0) continue;
            _settleForcedExit(positionIds[i]);
        }
    }

    /// @dev Move the L2 sequencer-uptime feed: down (1 in 12), just back up (grace hour, 1 in 12), or up for two hours.
    ///      While it is down nothing is liquidated or opened; during grace only positions below MM / 2 are liquidated
    ///      (IA-07), and closes of liquidatable positions settle as plain closes when the liquidation is not allowed.
    function sequencer(uint256 seed) external {
        if (address(sequencerFeed) == address(0)) return;
        uint256 k = seed % 12;
        if (k == 0) {
            sequencerFeed.set(1, block.timestamp);
            sequencerDowns++;
        } else if (k == 1) {
            sequencerFeed.set(0, block.timestamp);
            sequencerGraces++;
        } else {
            sequencerFeed.set(0, block.timestamp - 2 hours);
        }
    }

    function advanceFunding(uint256 stockSeed) external {
        try perps.advanceFunding(address(stocks[stockSeed % 2])) {} catch {}
    }

    // ------------------------------------------------------------ cover claims and guardian

    /// @dev Pay one recorded claim of an ended epoch (the budget was fixed while the epoch ran).
    function claimCover(uint256 epochSeed, uint256 claimantSeed) external {
        if (claimEpochs.length == 0) return;
        uint256 e = claimEpochs[epochSeed % claimEpochs.length];
        if (e >= perps.currentCoverEpoch()) return;
        address a = _claimants[e][claimantSeed % _claimants[e].length];
        if (perps.coverClaims(e, a) == 0) return;
        _claim(e, a);
    }

    function _claim(uint256 e, address a) internal {
        (,, uint256 budgetBefore,,,,,) = perps.coverEpochs(e);
        perps.claimCover(e, a);
        coverClaimsPaid++;
        (,, uint256 budget,,,,,) = perps.coverEpochs(e);
        if (budget != budgetBefore) coverOverCap = true; // settling never changes the budget
    }

    /// @dev Let time pass into a later cover epoch.
    function passEpoch(uint256 secs) external {
        vm.warp(block.timestamp + bound(secs, 1 hours, 3 hours));
        refreshPrices();
    }

    /// @dev Guardian switches close-only (on an eighth of the time, so opens still happen).
    function toggleCloseOnly(uint256 stockSeed, uint256 onSeed) external {
        uint256 perpsBal = vault.balanceOf(address(perps), address(usdg));
        uint256 ins = perps.insurance();
        uint256 margin = perps.totalMargin();
        vm.prank(guardian);
        perps.setCloseOnly(address(stocks[stockSeed % 2]), onSeed % 8 == 0);
        closeOnlyToggles++;
        if (
            vault.balanceOf(address(perps), address(usdg)) != perpsBal || perps.insurance() != ins
                || perps.totalMargin() != margin
        ) guardianMovedFunds = true;
    }

    // ------------------------------------------------------------ launch guard admin

    /// @dev One selector for every guard action, so the main suites' action mix is barely diluted: allowlist an
    ///      actor, raise caps, open to the public or lift the caps (each one time in two), hand the role over, or an
    ///      actor re-grants an approval. The guard suite targets the actions one by one.
    function guardAction(uint256 op, uint256 seed, uint256 x, uint256 y) external {
        op %= 6;
        if (op == 0) guardAllowlist(seed);
        else if (op == 1) guardRaiseCaps(seed, x, y);
        else if (op == 2 && x % 2 == 0) _openToPublic();
        else if (op == 3 && x % 2 == 0) _liftCaps();
        else if (op == 4) guardHandover(seed);
        else if (op == 5) approveModules(seed);
    }

    /// @dev The guard admin allowlists an actor (which then approves the modules).
    function guardAllowlist(uint256 actorSeed) public {
        if (!vault.allowlistActive()) return;
        address a = _actor(actorSeed);
        bytes32 before = fundsHash();
        vm.prank(vault.guardAdmin());
        vault.addToAllowlist(_one(a));
        _afterAdmin(before);
        _approveModules(a);
    }

    /// @dev The guard admin raises one token's caps by up to 50%, plus one minimum deposit (so a zero cap grows).
    function guardRaiseCaps(uint256 tokenSeed, uint256 accountPct, uint256 globalPct) public {
        if (!vault.capsActive()) return;
        address t = address(_token(tokenSeed));
        uint256 step = t == address(usdg) ? 100e6 : 1e15;
        uint256 a = vault.accountCap(t);
        uint256 g = vault.globalCap(t);
        a += (a * bound(accountPct, 0, 50)) / 100 + step;
        g += (g * bound(globalPct, 0, 50)) / 100 + step;
        if (g < a) g = a;
        bytes32 before = fundsHash();
        vm.prank(vault.guardAdmin());
        vault.raiseCaps(t, a, g);
        _afterAdmin(before);
    }

    /// @dev One time in eight: open to the public for good.
    function guardOpenToPublic(uint256 seed) external {
        if (seed % 8 == 0) _openToPublic();
    }

    /// @dev One time in eight: lift the caps for good.
    function guardLiftCaps(uint256 seed) external {
        if (seed % 8 == 0) _liftCaps();
    }

    /// @dev Every actor then approves the modules.
    function _openToPublic() internal {
        if (!vault.allowlistActive()) return;
        bytes32 before = fundsHash();
        vm.prank(vault.guardAdmin());
        vault.openToPublic();
        _afterAdmin(before);
        for (uint256 i; i < actors.length; ++i) {
            _approveModules(actors[i]);
        }
    }

    function _liftCaps() internal {
        if (!vault.capsActive()) return;
        bytes32 before = fundsHash();
        vm.prank(vault.guardAdmin());
        vault.liftCaps();
        _afterAdmin(before);
    }

    /// @dev Two-step handover to one of three admin keys; half the time the proposal is not accepted (yet).
    function guardHandover(uint256 seed) public {
        address admin = vault.guardAdmin();
        if (admin == address(0)) return;
        address next = makeAddr(string.concat("guard-admin-", vm.toString(seed % 3)));
        bytes32 before = fundsHash();
        vm.prank(admin);
        vault.transferGuardAdmin(next);
        if (seed % 2 == 0) {
            vm.prank(next);
            vault.acceptGuardAdmin();
        }
        _afterAdmin(before);
    }

    /// @dev An actor (re)grants a module approval: refused while it is outside an active allowlist.
    function approveModules(uint256 actorSeed) public {
        address a = _actor(actorSeed);
        bool refuse = vault.allowlistActive() && !vault.isAllowlisted(a);
        vm.prank(a);
        try vault.setApproval(address(perps), true) {
            if (refuse) guardBypassed = true;
        } catch (bytes memory err) {
            if (!refuse || !_isGuardError(err)) guardMisfired = true;
        }
    }

    function _afterAdmin(bytes32 before) internal {
        guardAdminActions++;
        if (fundsHash() != before) guardAdminMovedFunds = true;
        if ((vault.guardAdmin() != address(0)) != vault.guarded()) guardMisfired = true;
    }

    /// @dev Everything the guard admin must never touch: internal and token balances of everyone, totals, pool
    ///      reserves, margins, the fund, reserved cover and offer backing.
    function fundsHash() public view returns (bytes32 h) {
        address[4] memory held = [address(vault), address(pools), address(book), address(perps)];
        for (uint256 k; k < 3; ++k) {
            address t = address(_token(k));
            h = keccak256(abi.encode(h, vault.totalInternal(t), MockERC20(t).balanceOf(address(vault))));
            for (uint256 i; i < actors.length; ++i) {
                h = keccak256(abi.encode(h, vault.balanceOf(actors[i], t), MockERC20(t).balanceOf(actors[i])));
            }
            h = keccak256(abi.encode(h, vault.balanceOf(liquidator, t)));
            for (uint256 i; i < held.length; ++i) {
                h = keccak256(abi.encode(h, vault.balanceOf(held[i], t)));
            }
        }
        (uint256 s0, uint256 u0,,) = pools.pools(address(stocks[0]));
        (uint256 s1, uint256 u1,,) = pools.pools(address(stocks[1]));
        h = keccak256(abi.encode(h, s0, u0, s1, u1));
        h = keccak256(abi.encode(h, perps.totalMargin(), perps.insurance(), perps.coverReserved(), book.totalBacking()));
    }

    /// @dev Invariant 6 (launch guard): no deposit or approval got past an active allowlist, every refusal was the
    ///      guard's and expected, no valid exit reverted, the admin never moved funds; while caps are active the
    ///      vault's net deposits equal the ghost copy and stay within the account cap, and holdings within the global
    ///      cap; a guard admin exists exactly while some part of the guard is active.
    function checkLaunchGuard() external view {
        assertFalse(guardBypassed, "the guard let a deposit or approval through");
        assertFalse(guardMisfired, "the guard misfired: wrong refusal, or admin role out of step with the guard");
        assertFalse(exitBlocked, "a withdrawal or exit was blocked");
        assertFalse(guardAdminMovedFunds, "a guard-admin action moved funds");
        assertEq(vault.guardAdmin() != address(0), vault.guarded(), "admin iff guarded");
        if (!vault.capsActive()) return;
        for (uint256 k; k < 3; ++k) {
            address t = address(_token(k));
            assertLe(vault.totalInternal(t), vault.globalCap(t), "global cap exceeded");
            for (uint256 i; i <= actors.length; ++i) {
                address a = i == actors.length ? liquidator : actors[i];
                assertEq(vault.netDeposited(a, t), ghostNet[a][t], "net deposits");
                assertLe(ghostNet[a][t], vault.accountCap(t), "account cap exceeded");
            }
        }
    }

    /// @dev After the wind-down: every actor and the keeper withdraw everything they hold, whatever the guard's state.
    function withdrawEverything() external {
        for (uint256 k; k < 3; ++k) {
            MockERC20 t = _token(k);
            for (uint256 i; i <= actors.length; ++i) {
                address a = i == actors.length ? liquidator : actors[i];
                uint256 bal = vault.balanceOf(a, address(t));
                if (bal != 0) _withdraw(a, t, bal);
            }
        }
    }

    // ------------------------------------------------------------ market

    /// @dev Move one relayed price by up to ±5% and refresh both. Usually the move comes slowly enough for
    ///      the rate limit (1% per minute) to absorb it; a quarter of the moves are fast (one second), so the
    ///      reported price lags for a while and lagging-price paths get exercised.
    function movePrice(uint256 stockSeed, uint256 bps, bool up, bool slow) external {
        uint256 k = stockSeed % 2;
        bps = bound(bps, 0, 500);
        uint256 move = (price[k] * bps) / 10_000;
        uint256 next = up ? price[k] + move : price[k] - move;
        if (next < 2e18 || next > 50_000e18) return;
        price[k] = next;
        // bps x 60 s per 100 bps, plus slack for rounding; refreshPrices adds the last second
        if (slow || bps % 4 != 0) vm.warp(block.timestamp + (bps * 60) / 100 + 2);
        refreshPrices();
    }

    /// @dev A 15-40% gap with keepers absent: the rate-limited price walks there (5% per window) and nobody
    ///      liquidates on the way, so positions can end insolvent (shortfall claims, audit F-02).
    function gap(uint256 stockSeed, uint256 pct, bool up) external {
        uint256 k = stockSeed % 2;
        uint256 move = (price[k] * bound(pct, 15, 40)) / 100;
        uint256 next = up ? price[k] + move : price[k] - move;
        if (next < 2e18 || next > 50_000e18) return;
        price[k] = next;
        refreshPrices();
        for (uint256 i; i < 12 && oracle.lagging(address(stocks[k])); ++i) {
            vm.warp(block.timestamp + oracle.MOVE_WINDOW());
            refreshPrices();
        }
        gaps++;
    }

    /// @dev Let time pass (funding accrues), then refresh prices.
    function passTime(uint256 secs) external {
        vm.warp(block.timestamp + bound(secs, 1, 3 hours));
        refreshPrices();
    }

    // ------------------------------------------------------------ wind down (afterInvariant)

    function windDown() external virtual {
        _windDown();
    }

    function _windDown() internal {
        // Closes refuse a lagging price: let the rate-limited price catch up with the relayed prices.
        for (uint256 i; i < 400; ++i) {
            if (!oracle.lagging(address(stocks[0])) && !oracle.lagging(address(stocks[1]))) break;
            vm.warp(block.timestamp + oracle.MOVE_WINDOW());
            refreshPrices();
        }
        refreshPrices();
        for (uint256 i; i < positionIds.length; ++i) {
            PerpsBase.Position memory p = perps.getPosition(positionIds[i]);
            if (!p.open) continue;
            bool capWasSet = _capSet();
            Payees memory b = _payees(p, p.taker);
            vm.recordLogs();
            vm.prank(p.taker);
            perps.close(positionIds[i], p.isLong ? 1 : type(uint256).max);
            if (_checkPayout(p, p.taker, b, vm.getRecordedLogs())) closeLiquidations++;
            _trackClaims(p, capWasSet);
        }
        for (uint256 i; i < offerIds.length; ++i) {
            (address maker,,,,,,, bool active) = book.offers(offerIds[i]);
            if (!active) continue;
            vm.prank(maker);
            book.withdrawOffer(offerIds[i]);
        }
        for (uint256 a; a < actors.length; ++a) {
            for (uint256 s; s < 2; ++s) {
                uint256 sh = pools.sharesOf(address(stocks[s]), actors[a]);
                if (sh == 0) continue;
                vm.prank(actors[a]);
                try pools.removeLiquidity(address(stocks[s]), sh, 1, 1, block.timestamp) {}
                catch (bytes memory err) {
                    if (_isGuardError(err)) exitBlocked = true;
                }
            }
        }
        // Pay every outstanding cover claim once its epoch has ended.
        vm.warp(block.timestamp + perps.COVER_EPOCH());
        for (uint256 i; i < claimEpochs.length; ++i) {
            uint256 e = claimEpochs[i];
            for (uint256 j; j < _claimants[e].length; ++j) {
                if (perps.coverClaims(e, _claimants[e][j]) != 0) _claim(e, _claimants[e][j]);
            }
        }
    }
}
