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

struct Sys {
    VelumVault vault;
    OracleAdapter oracle;
    SpotPools pools;
    MakerBook book;
    PerpsMarkets perps;
}

/// @notice Independent audit handler (launch guard, commit 074ae11). Drives a GUARDED system `g` and an UNGUARDED mirror
///         `u` with the same calls, same tokens, same actors, same prices and same block times. Deposits and approvals
///         reach `u` only when `g` accepted them, so both systems hold identical state as long as the guard does
///         nothing but filter deposits and approvals. Every other call (trades, exits, keepers, claims) must then have
///         the same outcome and return data in both. Independent model: allowlist flags, switches and net deposits are
///         ghost copies, never read back from the vault.
///         Actors 0-2 start allowlisted; 3-4 are outsiders the admin may allowlist later; 5 is a keeper that is never
///         allowlisted. Outsiders try every module action too.
///         Adapted to the G-01 fix: the ghost model also predicts the room rule (an allowlisting or cap raise that would
///         leave a global cap below account cap x allowlisted is refused with `Oversubscribed`; half the time the admin
///         raises the global caps first), `openToPublic` is refused while caps are active, and a deposit refused by the
///         global cap is a violation. Relay pushes carry their observation time (on-chain workers audit M-1).
contract GuardDiffHandler is Test {
    uint8 internal constant VAULT = 0;
    uint8 internal constant POOLS = 1;
    uint8 internal constant BOOK = 2;
    uint8 internal constant PERPS = 3;

    Sys internal g;
    Sys internal u;
    MockERC20 public usdg;
    MockERC20[2] public stocks;
    address public relayer;
    address[] public actors;
    address public keeper;
    uint256[2] public price;
    uint256[] public offerIds;
    uint256[] public positionIds;
    uint256[] public epochs;

    // ghost model of the guard
    bool public ghostAllowlistActive = true;
    bool public ghostCapsActive = true;
    mapping(address => bool) public ghostAllow;
    uint256 public ghostAllowCount = 3;
    uint256 public roomRefusals;
    mapping(address account => mapping(address token => uint256)) public ghostNd;
    mapping(address token => uint256) public lastAccountCap;
    mapping(address token => uint256) public lastGlobalCap;

    string public violation;
    uint256 public outsiderAttempts;
    uint256 public guardRefusals;
    uint256 public diffCalls;
    uint256 public opens;
    uint256 public liquidations;
    uint256 public adminActions;
    uint256 public withdrawals;
    uint256 public openTries;
    bytes4 public lastOpenErr;

    constructor(Sys memory g_, Sys memory u_, MockERC20 usdg_, MockERC20[2] memory stocks_, address relayer_) {
        g = g_;
        u = u_;
        usdg = usdg_;
        stocks = stocks_;
        relayer = relayer_;
        price = [uint256(391.65e18), 233.4e18];
        for (uint256 i; i < 5; ++i) {
            actors.push(makeAddr(string.concat("actor-", vm.toString(i))));
        }
        keeper = makeAddr("keeper");
        actors.push(keeper);
        for (uint256 i; i < 3; ++i) {
            ghostAllow[actors[i]] = true;
        }
        address[3] memory toks = [address(usdg), address(stocks[0]), address(stocks[1])];
        for (uint256 i; i < 3; ++i) {
            lastAccountCap[toks[i]] = g.vault.accountCap(toks[i]);
            lastGlobalCap[toks[i]] = g.vault.globalCap(toks[i]);
        }
        vm.deal(address(this), 1000 ether);
    }

    // ------------------------------------------------------------ plumbing

    function actorCount() external view returns (uint256) {
        return actors.length;
    }

    function systems() external view returns (Sys memory, Sys memory) {
        return (g, u);
    }

    function _fail(string memory why) internal {
        if (bytes(violation).length == 0) violation = why;
    }

    function _actor(uint256 seed) internal view returns (address) {
        return actors[seed % actors.length];
    }

    /// @dev The actor after `seed` (wraps; no overflow for any seed).
    function _next(uint256 seed, uint256 i) internal view returns (address) {
        return actors[((seed % actors.length) + i) % actors.length];
    }

    function _token(uint256 seed) internal view returns (MockERC20) {
        uint256 k = seed % 3;
        return k == 0 ? usdg : stocks[k - 1];
    }

    function _target(Sys storage s, uint8 t) internal view returns (address) {
        if (t == VAULT) return address(s.vault);
        if (t == POOLS) return address(s.pools);
        if (t == BOOK) return address(s.book);
        return address(s.perps);
    }

    function _exec(Sys storage s, uint8 t, address caller, bytes memory data, uint256 value)
        internal
        returns (bool ok, bytes memory ret)
    {
        if (value != 0) vm.deal(caller, caller.balance + value);
        vm.prank(caller);
        (ok, ret) = _target(s, t).call{value: value}(data);
    }

    /// @dev Same call on both systems; outcome and return data must match.
    function _mirror(uint8 t, address caller, bytes memory data, uint256 value)
        internal
        returns (bool okG, bytes memory retG)
    {
        diffCalls++;
        (okG, retG) = _exec(g, t, caller, data, value);
        (bool okU, bytes memory retU) = _exec(u, t, caller, data, value);
        if (okG != okU) {
            _fail(
                string.concat(
                    "DIFF outcome, selector ",
                    vm.toString(bytes4(data)),
                    okG ? " ok in guarded, reverted unguarded: " : " reverted in guarded only: ",
                    vm.toString(okG ? retU : retG)
                )
            );
        } else if (okG && keccak256(retG) != keccak256(retU)) {
            _fail(string.concat("DIFF return data, selector ", vm.toString(bytes4(data))));
        }
    }

    function _isGuardErr(bytes memory err) internal pure returns (bool) {
        if (err.length < 4) return false;
        bytes4 s = bytes4(err);
        return s == VelumVault.NotAllowlisted.selector || s == VelumVault.AccountCapExceeded.selector
            || s == VelumVault.GlobalCapExceeded.selector || s == VelumVault.NotGuardAdmin.selector
            || s == VelumVault.NotPendingGuardAdmin.selector || s == VelumVault.AllowlistInactive.selector
            || s == VelumVault.CapsInactive.selector || s == VelumVault.CapDecrease.selector
            || s == VelumVault.BadCaps.selector || s == VelumVault.Oversubscribed.selector
            || s == VelumVault.CapsStillActive.selector;
    }

    /// @dev G-01 in the ghost model: every token's ghost global cap covers `count` ghost account caps.
    function ghostRoomFor(uint256 count) public view returns (bool) {
        address[3] memory toks = [address(usdg), address(stocks[0]), address(stocks[1])];
        for (uint256 i; i < 3; ++i) {
            if (lastAccountCap[toks[i]] * count > lastGlobalCap[toks[i]]) return false;
        }
        return true;
    }

    function _allowed(address a) internal view returns (bool) {
        return !ghostAllowlistActive || ghostAllow[a];
    }

    /// @dev A module action that needs funds or an approval: an outsider must never get it through.
    function _use(uint8 t, address caller, bytes memory data) internal returns (bool ok, bytes memory ret) {
        bool outsider = !_allowed(caller);
        if (outsider) outsiderAttempts++;
        (ok, ret) = _mirror(t, caller, data, 0);
        if (ok && outsider) _fail(string.concat("P1 outsider used a module, selector ", vm.toString(bytes4(data))));
    }

    /// @dev An exit, keeper or claim action: never refused by the guard.
    function _exit(uint8 t, address caller, bytes memory data, uint256 value) internal returns (bool ok) {
        bytes memory ret;
        (ok, ret) = _mirror(t, caller, data, value);
        if (!ok && _isGuardErr(ret)) _fail(string.concat("P3 exit refused by the guard: ", vm.toString(ret)));
    }

    function refresh() public {
        vm.warp(block.timestamp + 1);
        address[] memory t = new address[](2);
        uint256[] memory v = new uint256[](2);
        (t[0], t[1]) = (address(stocks[0]), address(stocks[1]));
        (v[0], v[1]) = (price[0], price[1]);
        vm.prank(relayer);
        g.oracle.pushPrices(t, v, block.timestamp);
        vm.prank(relayer);
        u.oracle.pushPrices(t, v, block.timestamp);
    }

    /// @dev Starting state through the checked paths: actors 0-2 deposit, actor 0 posts an offer per market, actors 1-2
    ///      seed both pools. Same in both systems.
    function seedState() external {
        for (uint256 i; i < 3; ++i) {
            this.deposit(i, 0, 0, 3000e6);
            this.deposit(i, 0, 1, 6e18);
            this.deposit(i, 0, 2, 6e18);
        }
        this.postOffer(0, 0, 1500e6, 100, 5, 5);
        this.postOffer(0, 1, 1000e6, 100, 5, 5);
        this.addLiquidity(1, 0, 4e18, 1600e6);
        this.addLiquidity(2, 1, 4e18, 1000e6);
    }

    // ------------------------------------------------------------ vault: deposit / withdraw / approve

    /// @dev A deposit of exactly the remaining room (account or global, whichever is smaller) minus one, exactly, or
    ///      plus one: probes both caps at their boundary.
    function depositEdge(uint256 actorSeed, uint256 tokenSeed, uint256 delta) external {
        if (!ghostCapsActive) return;
        address a = _actor(actorSeed % 3); // allowlisted
        address t = address(_token(tokenSeed));
        uint256 accountRoom = lastAccountCap[t] - ghostNd[a][t];
        uint256 total = g.vault.totalInternal(t);
        uint256 globalRoom = lastGlobalCap[t] > total ? lastGlobalCap[t] - total : 0;
        uint256 room = accountRoom < globalRoom ? accountRoom : globalRoom;
        delta %= 3;
        uint256 amount = room + delta;
        if (amount <= 1) return;
        amount -= 1; // room - 1, room, room + 1
        _deposit(a, a, MockERC20(t), amount);
    }

    function deposit(uint256 fromSeed, uint256 toSeed, uint256 tokenSeed, uint256 amount) external {
        address from = _actor(fromSeed);
        address to = toSeed % 3 == 0 ? from : _actor(toSeed);
        MockERC20 t = _token(tokenSeed);
        amount = bound(amount, 1, t == usdg ? 5000e6 : 20e18);
        _deposit(from, to, t, amount);
    }

    function _deposit(address from, address to, MockERC20 t, uint256 amount) internal {
        t.mint(from, 2 * amount);
        vm.startPrank(from);
        t.approve(address(g.vault), type(uint256).max);
        t.approve(address(u.vault), type(uint256).max);
        vm.stopPrank();
        bool refuse = (ghostAllowlistActive && (!ghostAllow[from] || !ghostAllow[to]))
            || (ghostCapsActive
                && (ghostNd[to][address(t)] + amount > lastAccountCap[address(t)]
                    || g.vault.totalInternal(address(t)) + amount > lastGlobalCap[address(t)]));
        bytes memory data = abi.encodeCall(VelumVault.deposit, (address(t), amount, to));
        (bool okG, bytes memory err) = _exec(g, VAULT, from, data, 0);
        if (okG) {
            if (refuse) _fail("P1/P2 a deposit the guard must refuse went through");
            if (ghostCapsActive) ghostNd[to][address(t)] += amount;
            (bool okU,) = _exec(u, VAULT, from, data, 0);
            if (!okU) _fail("DIFF deposit accepted by guarded vault, refused by unguarded");
        } else {
            guardRefusals++;
            if (!refuse) {
                _fail(string.concat("misfire: deposit refused: ", vm.toString(err)));
            } else if (!_isGuardErr(err)) {
                _fail(string.concat("misfire: non-guard refusal: ", vm.toString(err)));
            } else if (bytes4(err) == VelumVault.GlobalCapExceeded.selector) {
                _fail("G-01 the global cap refused a deposit");
            }
        }
    }

    function withdraw(uint256 actorSeed, uint256 tokenSeed, uint256 amount, uint256 toSeed) public {
        address a = _actor(actorSeed);
        MockERC20 t = _token(tokenSeed);
        uint256 bal = g.vault.balanceOf(a, address(t));
        if (bal == 0) return;
        amount = bound(amount, 1, bal);
        address to = toSeed % 3 == 0 ? a : _actor(toSeed);
        (bool ok,) = _mirror(VAULT, a, abi.encodeCall(VelumVault.withdraw, (address(t), amount, to)), 0);
        if (!ok) _fail("P3 a valid withdrawal reverted");
        withdrawals++;
        if (ghostCapsActive) {
            uint256 n = ghostNd[a][address(t)];
            ghostNd[a][address(t)] = n > amount ? n - amount : 0;
        }
    }

    function approve(uint256 actorSeed, uint256 moduleSeed, bool ok) external {
        address a = _actor(actorSeed);
        uint8 m = uint8(1 + (moduleSeed % 3));
        bool refuse = ok && ghostAllowlistActive && !ghostAllow[a];
        (bool okG, bytes memory err) =
            _exec(g, VAULT, a, abi.encodeCall(VelumVault.setApproval, (_target(g, m), ok)), 0);
        if (okG) {
            if (refuse) _fail("P1 an outsider approved a module");
            (bool okU,) = _exec(u, VAULT, a, abi.encodeCall(VelumVault.setApproval, (_target(u, m), ok)), 0);
            if (!okU) _fail("DIFF approval");
        } else {
            guardRefusals++;
            if (!refuse || bytes4(err) != VelumVault.NotAllowlisted.selector) _fail("misfire: approval refused");
        }
    }

    // ------------------------------------------------------------ modules: uses (anyone tries, outsiders included)

    function postOffer(uint256 actorSeed, uint256 stockSeed, uint256 backing, uint256 fillPct, uint16 o, uint16 c)
        external
    {
        address a = _actor(actorSeed);
        uint256 bal = g.vault.balanceOf(a, address(usdg));
        backing = bal < 20e6 ? 10e6 : bound(backing, 10e6, bal);
        bytes memory data = _offerData(address(stocks[stockSeed % 2]), backing, fillPct, o, c);
        (bool ok, bytes memory ret) = _use(BOOK, a, data);
        if (ok) offerIds.push(abi.decode(ret, (uint256)));
    }

    function _offerData(address stock, uint256 backing, uint256 fillPct, uint16 o, uint16 c)
        internal
        view
        returns (bytes memory)
    {
        uint256 largest = (backing * bound(fillPct, 10, 100)) / 100;
        if (largest == 0) largest = backing;
        return abi.encodeCall(
            MakerBook.postOffer,
            (
                stock,
                backing,
                largest,
                uint16(bound(o, 2, 500)),
                uint16(bound(c, 0, 500)),
                uint64(block.timestamp + 30 days)
            )
        );
    }

    function open(uint256 actorSeed, uint256 offerIdx, bool isLong, uint256 size, uint8 lev) external {
        if (offerIds.length == 0) return;
        uint256 id = offerIds[offerIdx % offerIds.length];
        (address maker, address market,,,,,, bool active) = g.book.offers(id);
        if (!active) return;
        address a = _actor(actorSeed);
        if (actorSeed % 2 == 0) {
            for (uint256 i; i < actors.length && (a == maker || g.vault.balanceOf(a, address(usdg)) < 20e6); ++i) {
                a = _next(actorSeed, i);
            }
        }
        if (a == maker) a = _next(actorSeed, 1);
        lev = uint8(bound(lev, 2, 10));
        size = _openSize(id, a, lev, market, size);
        refresh();
        bytes memory data =
            abi.encodeCall(PerpsMarkets.open, (id, market, isLong, size, lev, isLong ? type(uint256).max : 1));
        openTries++;
        (bool ok, bytes memory ret) = _use(PERPS, a, data);
        if (ok) {
            positionIds.push(abi.decode(ret, (uint256)));
            opens++;
        } else if (ret.length >= 4) {
            lastOpenErr = bytes4(ret);
        }
    }

    function _openSize(uint256 id, address a, uint8 lev, address market, uint256 size) internal view returns (uint256) {
        (,, uint256 backing, uint256 largest,,,,) = g.book.offers(id);
        uint256 maxSize = (g.vault.balanceOf(a, address(usdg)) * lev * 99) / 200;
        if (largest < maxSize) maxSize = largest;
        if (backing * 5 < maxSize) maxSize = backing * 5;
        uint256 qtyCap = (price[market == address(stocks[0]) ? 0 : 1] * 99) / 1e12;
        if (qtyCap < maxSize) maxSize = qtyCap;
        return maxSize < 10e6 ? 10e6 : bound(size, 10e6, maxSize);
    }

    function addMargin(uint256 idx, uint256 amount, uint256 whoSeed) external {
        if (positionIds.length == 0) return;
        uint256 id = positionIds[idx % positionIds.length];
        PerpsBase.Position memory p = g.perps.getPosition(id);
        address who = whoSeed % 3 == 0 ? p.taker : whoSeed % 3 == 1 ? p.maker : _actor(whoSeed);
        uint256 bal = g.vault.balanceOf(who, address(usdg));
        amount = bal == 0 ? 1e6 : bound(amount, 1, bal);
        _use(PERPS, who, abi.encodeCall(PerpsMarkets.addMargin, (id, amount)));
    }

    function fundInsurance(uint256 actorSeed, uint256 amount) external {
        address a = _actor(actorSeed);
        uint256 bal = g.vault.balanceOf(a, address(usdg));
        amount = bal == 0 ? 1e6 : bound(amount, 1, bal);
        _use(PERPS, a, abi.encodeCall(PerpsMarkets.fundInsurance, (amount)));
    }

    function addLiquidity(uint256 actorSeed, uint256 stockSeed, uint256 s, uint256 v) external {
        address a = _actor(actorSeed);
        address stock = address(stocks[stockSeed % 2]);
        uint256 sb = g.vault.balanceOf(a, stock);
        uint256 ub = g.vault.balanceOf(a, address(usdg));
        s = sb < 1e15 ? 1e18 : bound(s, 1e15, sb);
        v = ub < 1e6 ? 100e6 : bound(v, 1e6, ub);
        _use(POOLS, a, abi.encodeCall(SpotPools.addLiquidity, (stock, s, v, 1, block.timestamp)));
    }

    function swap(uint256 actorSeed, uint256 inSeed, uint256 outSeed, uint256 amount) external {
        address a = _actor(actorSeed);
        MockERC20 tin = _token(inSeed);
        MockERC20 tout = _token(outSeed);
        if (tin == tout) tout = _token((outSeed % 3) + 1);
        uint256 bal = g.vault.balanceOf(a, address(tin));
        amount = bal == 0 ? (tin == usdg ? 10e6 : 1e16) : bound(amount, 1, bal);
        _use(POOLS, a, abi.encodeCall(SpotPools.swap, (address(tin), address(tout), amount, 1, block.timestamp)));
    }

    // ------------------------------------------------------------ exits, keepers, claims

    function withdrawOffer(uint256 idx) external {
        if (offerIds.length == 0) return;
        uint256 id = offerIds[idx % offerIds.length];
        (address maker,,,,,,, bool active) = g.book.offers(id);
        if (!active) return;
        if (!_exit(BOOK, maker, abi.encodeCall(MakerBook.withdrawOffer, (id)), 0)) _fail("P3 offer withdrawal");
    }

    function close(uint256 idx) external {
        if (positionIds.length == 0) return;
        uint256 id = positionIds[idx % positionIds.length];
        PerpsBase.Position memory p = g.perps.getPosition(id);
        if (!p.open) return;
        refresh();
        _exit(PERPS, p.taker, abi.encodeCall(PerpsMarkets.close, (id, p.isLong ? 1 : type(uint256).max)), 0);
    }

    function removeMargin(uint256 idx, uint256 amount) external {
        if (positionIds.length == 0) return;
        uint256 id = positionIds[idx % positionIds.length];
        PerpsBase.Position memory p = g.perps.getPosition(id);
        if (!p.open || p.takerMargin == 0) return;
        amount = bound(amount, 1, p.takerMargin);
        refresh();
        _exit(PERPS, p.taker, abi.encodeCall(PerpsMarkets.removeMargin, (id, amount)), 0);
    }

    function liquidate(uint256 idx, uint256 whoSeed) external {
        if (positionIds.length == 0) return;
        uint256 id = positionIds[idx % positionIds.length];
        if (!g.perps.getPosition(id).open) return;
        refresh();
        address who = whoSeed % 2 == 0 ? keeper : _actor(whoSeed);
        if (_exit(PERPS, who, abi.encodeWithSignature("liquidate(uint256)", id), 0)) {
            liquidations++;
            epochs.push(block.timestamp / 1 hours);
        }
    }

    function forcedExit(uint256 idx, bool byMaker, uint256 settlerSeed) external {
        if (positionIds.length == 0) return;
        uint256 id = positionIds[idx % positionIds.length];
        PerpsBase.Position memory p = g.perps.getPosition(id);
        if (!p.open) return;
        if (p.exitRequestedAt == 0) {
            bool ok = _exit(
                PERPS,
                byMaker ? p.maker : p.taker,
                abi.encodeWithSignature("requestForcedExit(uint256)", id),
                0.001 ether
            );
            if (!ok) return;
        }
        vm.warp(block.timestamp + 7 days);
        refresh();
        address settler = settlerSeed % 2 == 0 ? keeper : _actor(settlerSeed);
        if (_exit(PERPS, settler, abi.encodeWithSignature("settleForcedExit(uint256)", id), 0)) {
            epochs.push(block.timestamp / 1 hours);
        }
    }

    function removeLiquidity(uint256 actorSeed, uint256 stockSeed, uint256 pct) public {
        address a = _actor(actorSeed);
        address stock = address(stocks[stockSeed % 2]);
        uint256 have = g.pools.sharesOf(stock, a);
        if (have == 0) return;
        uint256 shares = (have * bound(pct, 1, 100)) / 100;
        if (shares == 0) shares = have;
        _exit(POOLS, a, abi.encodeCall(SpotPools.removeLiquidity, (stock, shares, 1, 1, block.timestamp)), 0);
    }

    function claimCover(uint256 epochIdx, uint256 actorSeed) public {
        if (epochs.length == 0) return;
        uint256 e = epochs[epochIdx % epochs.length];
        address a = _actor(actorSeed);
        if (g.perps.coverClaims(e, a) == 0) return;
        if (e >= block.timestamp / 1 hours) vm.warp((e + 1) * 1 hours + 1);
        _exit(PERPS, keeper, abi.encodeWithSignature("claimCover(uint256,address)", e, a), 0);
    }

    function claimBond(uint256 actorSeed) public {
        address a = _actor(actorSeed);
        if (g.perps.bondRefunds(a) == 0) return;
        if (!_exit(PERPS, a, abi.encodeWithSignature("claimBond()"), 0)) _fail("P3 bond claim");
    }

    // ------------------------------------------------------------ prices and time

    function movePrice(uint256 k, uint256 bps, bool up) external {
        k %= 2;
        bps = bound(bps, 0, 500);
        uint256 move = (price[k] * bps) / 10_000;
        uint256 next = up ? price[k] + move : price[k] - move;
        if (next < 5e18 || next > 50_000e18) return;
        price[k] = next;
        vm.warp(block.timestamp + (bps * 60) / 100 + 2);
        refresh();
    }

    /// @dev A 12-35% move with keepers absent: the rate-limited price walks there (5% per window) so positions reach
    ///      liquidation, some insolvent (shortfall cover claims).
    function gap(uint256 k, uint256 pct, bool up) external {
        k %= 2;
        uint256 move = (price[k] * bound(pct, 12, 35)) / 100;
        uint256 next = up ? price[k] + move : price[k] - move;
        if (next < 5e18 || next > 50_000e18) return;
        price[k] = next;
        refresh();
        for (uint256 i; i < 12 && g.oracle.lagging(address(stocks[k])); ++i) {
            vm.warp(block.timestamp + 5 minutes);
            refresh();
        }
    }

    function passTime(uint256 secs) external {
        vm.warp(block.timestamp + bound(secs, 1, 3 hours));
        refresh();
    }

    // ------------------------------------------------------------ guard admin (guarded system only)

    bytes32 internal _hashBefore;

    function _beforeAdmin() internal {
        _hashBefore = fundsHash();
        adminActions++;
    }

    function _afterAdmin() internal {
        if (fundsHash() != _hashBefore) _fail("P4 a guard-admin action changed funds or approvals");
        if (!ghostAllowlistActive && !ghostCapsActive) {
            if (g.vault.guardAdmin() != address(0) || g.vault.pendingGuardAdmin() != address(0)) {
                _fail("P4 admin role not cleared after both switches went off");
            }
        }
    }

    /// @dev G-01: while caps are active, an address that is not yet listed needs one more account cap of global room
    ///      for every token. Half the time the admin raises the global caps first (to exactly cover it); otherwise the
    ///      allowlisting must be refused with `Oversubscribed` and change nothing.
    function adminAllowlist(uint256 actorSeed) external {
        address admin = g.vault.guardAdmin();
        if (admin == address(0) || !ghostAllowlistActive) return;
        address a = _actor(actorSeed);
        if (a == keeper) return; // the keeper stays outside for good
        address[] memory l = new address[](1);
        l[0] = a;
        _beforeAdmin();
        bool isNew = !ghostAllow[a];
        if (isNew && ghostCapsActive && !ghostRoomFor(ghostAllowCount + 1) && actorSeed % 2 == 0) {
            _makeRoom(admin, ghostAllowCount + 1);
        }
        bool fits = !isNew || !ghostCapsActive || ghostRoomFor(ghostAllowCount + 1);
        vm.prank(admin);
        try g.vault.addToAllowlist(l) {
            if (!fits) _fail("G-01 an allowlisting without global room went through");
            if (isNew) ghostAllowCount++;
            ghostAllow[a] = true;
        } catch (bytes memory err) {
            roomRefusals++;
            if (fits) _fail("admin allowlisting reverted");
            else if (bytes4(err) != VelumVault.Oversubscribed.selector) _fail("G-01 wrong refusal of an allowlisting");
        }
        _afterAdmin();
    }

    /// @dev The admin raises each ghost global cap that does not cover `count` account caps.
    function _makeRoom(address admin, uint256 count) internal {
        address[3] memory toks = [address(usdg), address(stocks[0]), address(stocks[1])];
        for (uint256 i; i < 3; ++i) {
            address t = toks[i];
            uint256 need = lastAccountCap[t] * count;
            if (need <= lastGlobalCap[t]) continue;
            vm.prank(admin);
            try g.vault.raiseCaps(t, lastAccountCap[t], need) {
                lastGlobalCap[t] = need;
            } catch {
                _fail("admin room raise reverted");
            }
        }
    }

    /// @dev Raise by up to 50% (+1). G-01: half the time a raise whose global cap would not cover the new account cap
    ///      for every allowlisted address is completed to exactly that; otherwise it must be refused with
    ///      `Oversubscribed`.
    function adminRaiseCaps(uint256 tokenSeed, uint256 aPct, uint256 gPct) external {
        address admin = g.vault.guardAdmin();
        if (admin == address(0) || !ghostCapsActive) return;
        address t = address(_token(tokenSeed));
        uint256 a = lastAccountCap[t] + (lastAccountCap[t] * bound(aPct, 0, 50)) / 100 + 1;
        uint256 gl = lastGlobalCap[t] + (lastGlobalCap[t] * bound(gPct, 0, 50)) / 100 + 1;
        if (a > gl) gl = a;
        uint256 need = a * ghostAllowCount;
        if (gl < need && gPct % 2 == 0) gl = need;
        _beforeAdmin();
        vm.prank(admin);
        try g.vault.raiseCaps(t, a, gl) {
            if (gl < need) _fail("G-01 a cap raise without global room went through");
            lastAccountCap[t] = a;
            lastGlobalCap[t] = gl;
        } catch (bytes memory err) {
            roomRefusals++;
            if (gl >= need) _fail("admin cap raise reverted");
            else if (bytes4(err) != VelumVault.Oversubscribed.selector) _fail("G-01 wrong refusal of a cap raise");
        }
        // lowering is always refused
        if (lastAccountCap[t] != 0) {
            vm.prank(admin);
            try g.vault.raiseCaps(t, lastAccountCap[t] - 1, lastGlobalCap[t]) {
                _fail("P2 a cap went down");
            } catch {}
        }
        if (lastGlobalCap[t] != 0) {
            vm.prank(admin);
            try g.vault.raiseCaps(t, lastAccountCap[t], lastGlobalCap[t] - 1) {
                _fail("P2 a cap went down");
            } catch {}
        }
        _afterAdmin();
    }

    /// @dev G-01: `openToPublic` is refused while caps are active (caps never apply without the allowlist).
    function adminSwitch(uint256 seed) external {
        address admin = g.vault.guardAdmin();
        if (admin == address(0) || seed % 10 != 0) return; // rare
        _beforeAdmin();
        if ((seed / 10) % 2 == 0 && ghostAllowlistActive) {
            vm.prank(admin);
            try g.vault.openToPublic() {
                if (ghostCapsActive) _fail("G-01 openToPublic went through with caps active");
                ghostAllowlistActive = false;
            } catch (bytes memory err) {
                if (!ghostCapsActive || bytes4(err) != VelumVault.CapsStillActive.selector) {
                    _fail("openToPublic refused for the wrong reason");
                }
            }
        } else if (ghostCapsActive) {
            vm.prank(admin);
            g.vault.liftCaps();
            ghostCapsActive = false;
        }
        _afterAdmin();
    }

    function adminHandover(uint256 seed, bool accept) external {
        address admin = g.vault.guardAdmin();
        if (admin == address(0)) return;
        address next = seed % 2 == 0 ? makeAddr(string.concat("admin-", vm.toString(seed % 3))) : _actor(seed);
        _beforeAdmin();
        vm.prank(admin);
        g.vault.transferGuardAdmin(next);
        if (accept) {
            // someone else cannot accept
            address other = _next(seed, 1);
            if (other != next) {
                vm.prank(other);
                try g.vault.acceptGuardAdmin() {
                    _fail("P4 handover hijacked");
                } catch {}
            }
            vm.prank(next);
            g.vault.acceptGuardAdmin();
            if (g.vault.guardAdmin() != next || g.vault.pendingGuardAdmin() != address(0)) _fail("handover state");
        }
        _afterAdmin();
    }

    /// @dev Somebody who is not the admin tries every admin power; all must fail (accept only for the pending admin).
    function attackAdmin(uint256 actorSeed, uint256 op) external {
        address a = _actor(actorSeed);
        if (a == g.vault.guardAdmin()) return;
        address[] memory l = new address[](1);
        l[0] = a;
        _beforeAdmin();
        vm.startPrank(a);
        op %= 6;
        bool ok;
        if (op == 0) {
            (ok,) = address(g.vault).call(abi.encodeCall(VelumVault.addToAllowlist, (l)));
        } else if (op == 1) {
            (ok,) = address(g.vault).call(abi.encodeCall(VelumVault.raiseCaps, (address(usdg), 1e30, 1e30)));
        } else if (op == 2) {
            (ok,) = address(g.vault).call(abi.encodeCall(VelumVault.openToPublic, ()));
        } else if (op == 3) {
            (ok,) = address(g.vault).call(abi.encodeCall(VelumVault.liftCaps, ()));
        } else if (op == 4) {
            (ok,) = address(g.vault).call(abi.encodeCall(VelumVault.transferGuardAdmin, (a)));
        } else if (a != g.vault.pendingGuardAdmin()) {
            (ok,) = address(g.vault).call(abi.encodeCall(VelumVault.acceptGuardAdmin, ()));
        }
        vm.stopPrank();
        if (ok) _fail("P4 a non-admin used an admin power");
        _afterAdmin();
    }

    // ------------------------------------------------------------ state views

    /// @dev Everything the guard admin must never touch, in the guarded system.
    function fundsHash() public view returns (bytes32 h) {
        return _stateHash(g);
    }

    function stateHash(bool guarded) external view returns (bytes32) {
        return guarded ? _stateHash(g) : _stateHash(u);
    }

    /// @dev Balances (actors and modules by role), totals, token holdings, approvals, pools, offers, positions, perps
    ///      accounting and bonds. Identical for `g` and `u` whenever the guard only filtered deposits and approvals.
    function _stateHash(Sys storage s) internal view returns (bytes32 h) {
        address[3] memory toks = [address(usdg), address(stocks[0]), address(stocks[1])];
        address[3] memory mods = [address(s.pools), address(s.book), address(s.perps)];
        for (uint256 i; i < 3; ++i) {
            address t = toks[i];
            h = keccak256(abi.encode(h, s.vault.totalInternal(t), MockERC20(t).balanceOf(address(s.vault))));
            for (uint256 m; m < 3; ++m) {
                h = keccak256(abi.encode(h, s.vault.balanceOf(mods[m], t)));
            }
            for (uint256 j; j < actors.length; ++j) {
                h = keccak256(abi.encode(h, s.vault.balanceOf(actors[j], t)));
            }
        }
        for (uint256 j; j < actors.length; ++j) {
            for (uint256 m; m < 3; ++m) {
                h = keccak256(abi.encode(h, s.vault.approved(actors[j], mods[m])));
            }
            h = keccak256(
                abi.encode(
                    h,
                    s.pools.sharesOf(toks[1], actors[j]),
                    s.pools.sharesOf(toks[2], actors[j]),
                    s.perps.bondRefunds(actors[j])
                )
            );
        }
        for (uint256 i = 1; i < 3; ++i) {
            (uint256 sr, uint256 ur, uint256 ts,) = s.pools.pools(toks[i]);
            h = keccak256(abi.encode(h, sr, ur, ts));
        }
        h = keccak256(
            abi.encode(
                h,
                s.perps.insurance(),
                s.perps.totalMargin(),
                s.perps.coverReserved(),
                s.perps.nextPositionId(),
                s.book.totalBacking(),
                s.book.nextOfferId()
            )
        );
        for (uint256 i; i < positionIds.length; ++i) {
            h = keccak256(abi.encode(h, s.perps.getPosition(positionIds[i])));
        }
        for (uint256 i; i < offerIds.length; ++i) {
            (,, uint256 backing,,,,, bool active) = s.book.offers(offerIds[i]);
            h = keccak256(abi.encode(h, backing, active));
        }
    }

    // ------------------------------------------------------------ wind down

    function settlePrices() public {
        for (uint256 i; i < 20; ++i) {
            refresh();
            if (!g.oracle.lagging(address(stocks[0])) && !g.oracle.lagging(address(stocks[1]))) return;
            vm.warp(block.timestamp + 5 minutes);
        }
    }

    function windDown() external {
        settlePrices();
        for (uint256 i; i < positionIds.length; ++i) {
            uint256 id = positionIds[i];
            PerpsBase.Position memory p = g.perps.getPosition(id);
            if (!p.open) continue;
            refresh();
            bool ok =
                _exit(PERPS, p.taker, abi.encodeCall(PerpsMarkets.close, (id, p.isLong ? 1 : type(uint256).max)), 0);
            if (!ok && _exit(PERPS, keeper, abi.encodeWithSignature("liquidate(uint256)", id), 0)) {
                epochs.push(block.timestamp / 1 hours);
            }
        }
        for (uint256 i; i < offerIds.length; ++i) {
            (address maker,,,,,,, bool active) = g.book.offers(offerIds[i]);
            if (active) _exit(BOOK, maker, abi.encodeCall(MakerBook.withdrawOffer, (offerIds[i])), 0);
        }
        for (uint256 j; j < actors.length; ++j) {
            removeLiquidity(j, 0, 100);
            removeLiquidity(j, 1, 100);
        }
        vm.warp(block.timestamp + 2 hours);
        for (uint256 e; e < epochs.length; ++e) {
            for (uint256 j; j < actors.length; ++j) {
                claimCover(e, j);
            }
        }
        for (uint256 j; j < actors.length; ++j) {
            claimBond(j);
        }
    }

    function withdrawEverything() external {
        for (uint256 j; j < actors.length; ++j) {
            for (uint256 k; k < 3; ++k) {
                uint256 bal = g.vault.balanceOf(actors[j], address(_token(k)));
                if (bal != 0) withdraw(j, k, bal, 0);
            }
        }
    }
}
