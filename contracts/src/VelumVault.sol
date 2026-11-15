// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IVelumVault} from "./interfaces/IVelumVault.sol";

/// @title VelumVault
/// @notice Holds every token in the protocol and keeps internal balances per (account, token).
///         Tokens leave only through `withdraw`, and only from the caller's own internal balance.
///         Modules (spot pools, maker book, perps) move internal balances between accounts; they
///         never mint and never transfer tokens out.
///
/// Launch guard (optional, for a guarded beta before the external audit). `deposit` is the only way tokens
/// enter the protocol: modules only move internal balances. So the guard sits on `deposit` alone (plus
/// `setApproval`, below) and is fixed at setup:
///   - guard admin zero: unguarded, open to everyone with no caps from the start (the testnet default);
///   - otherwise two independent one-way switches start on:
///       allowlist: only allowlisted addresses may deposit, as payer and as credited account, or approve a
///         module. Without an approval no module can debit an account, so an address that is not allowlisted
///         cannot open, post offers, add liquidity, swap, add margin or fund insurance. `openToPublic()`
///         turns it off for good, and only once the caps are lifted. Addresses can be added, never removed.
///       caps: per token, a per-account cap on `netDeposited` (deposits credited minus withdrawals, never below
///         zero) and a global cap on `totalInternal` (the vault's holdings), both in token base units. Caps can
///         only be raised; `liftCaps()` turns them off for good. The global cap always covers every allowlisted
///         address's full account cap (`globalCap >= accountCap × allowlistedCount`, enforced when addresses are
///         added and when caps are raised; independent audit G-01). The vault's holdings never exceed the sum of
///         `netDeposited`, and only allowlisted accounts have any, so a deposit within the account cap is always
///         within the global cap too: nobody, the admin included, can use up another account's room.
///         Caps never apply without the allowlist (`openToPublic` needs `liftCaps` first): open to everyone, the
///         global cap would again be room anyone could fill.
///   Withdrawals are never checked: a withdrawal only lowers `netDeposited` (saturating, it cannot revert), and
///   nothing a module does (closes, liquidations, forced exits, offer withdrawals, liquidity removal, cover
///   claims) goes through the guard. Once both switches are off the admin role is cleared and the guard is
///   inert: deposit then reads only the storage slot it already reads for `locked`.
///   The guard admin can add allowlisted addresses, raise caps, call `liftCaps` and then `openToPublic` and hand
///   the role over in two steps. It cannot move, freeze or redirect funds, block a withdrawal, remove an address,
///   lower a cap, use up anyone's deposit room or change anything else.
/// @dev No owner, no pause, no upgrade. The deployer calls `setup` exactly once to fix the token
///      list, the module set, the protocol addresses that may not receive deposits and the launch guard; after
///      that only the guard admin's powers above remain, and only until the guard is switched off.
contract VelumVault is IVelumVault, ReentrancyGuard {
    using SafeERC20 for IERC20;

    address public immutable deployer;
    bool public locked;
    // Launch guard. `guardAdmin`, `allowlistActive` and `capsActive` share `locked`'s storage slot, so an inert
    // guard adds no storage read to `deposit`.
    /// @notice The launch-guard admin: zero for an unguarded deployment and once both switches are off.
    address public guardAdmin;
    /// @notice While true only allowlisted addresses may deposit (as payer and as credited account) or approve
    ///         a module. One-way: `openToPublic` clears it.
    bool public allowlistActive;
    /// @notice While true deposits are capped per account and globally, per token. One-way: `liftCaps` clears it.
    bool public capsActive;
    /// @notice Proposed next guard admin (two-step handover); zero when none.
    address public pendingGuardAdmin;
    mapping(address account => bool) public isAllowlisted;
    /// @notice Largest `netDeposited` per account while caps are active, in token base units.
    mapping(address token => uint256) public accountCap;
    /// @notice Largest `totalInternal` (the vault's holdings of the token) while caps are active, in base units.
    mapping(address token => uint256) public globalCap;
    /// @notice Deposits credited to the account minus its withdrawals, never below zero, tracked while caps are
    ///         active. A withdrawal of more than this (profits, rewards) sets it to zero: it never becomes credit.
    mapping(address account => mapping(address token => uint256)) public netDeposited;
    /// @notice Number of allowlisted addresses (G-01). While caps are active, every token's global cap is at least
    ///         its account cap times this number.
    uint256 public allowlistedCount;
    /// @dev The listed tokens in setup order, for the G-01 check when addresses are added.
    address[] internal _tokens;

    mapping(address token => bool) public isToken;
    mapping(address module => bool) public isModule;
    /// @notice Protocol contracts that are not modules and can never call withdraw (e.g. the oracle).
    mapping(address account => bool) public isBlockedRecipient;
    mapping(address account => mapping(address token => uint256)) public balanceOf;
    /// @notice Sum of all internal balances per token. Always equals what the vault received
    ///         minus what it paid out, so it never exceeds the vault's token holdings.
    mapping(address token => uint256) public totalInternal;
    mapping(address account => mapping(address module => bool)) public approved;

    event Setup(address[] tokens, address[] modules, address[] blockedRecipients);
    /// @notice Public deposit ("shield" in the product). `amount` is what actually arrived.
    event Deposited(address indexed from, address indexed to, address indexed token, uint256 amount);
    /// @notice Public withdrawal ("unshield" in the product).
    event Withdrawn(address indexed from, address indexed to, address indexed token, uint256 amount);
    event ModuleApproval(address indexed account, address indexed module, bool approved);
    event InternalTransfer(
        address indexed module, address indexed token, address indexed from, address to, uint256 amount
    );
    /// @notice Launch guard fixed at setup; `admin` zero (and no caps) means unguarded. Caps follow `Setup.tokens`.
    event GuardSetup(address indexed admin, uint256[] accountCaps, uint256[] globalCaps);
    event Allowlisted(address indexed account);
    event CapsRaised(address indexed token, uint256 accountCap, uint256 globalCap);
    event OpenedToPublic();
    event CapsLifted();
    event GuardAdminTransferStarted(address indexed admin, address indexed pendingAdmin);
    /// @notice Also emitted with `newAdmin` zero when the last switch goes off and the role is cleared.
    event GuardAdminTransferred(address indexed previousAdmin, address indexed newAdmin);

    error NotDeployer();
    error AlreadySetUp();
    error NotSetUp();
    error ZeroAddress();
    error ZeroAmount();
    error UnknownToken(address token);
    error DuplicateToken(address token);
    error ModuleRecipient(address module);
    error ProtocolRecipient(address account);
    error NotModule(address caller);
    error NotApproved(address account, address module);
    error InsufficientBalance(address account, address token, uint256 balance, uint256 needed);
    error BadGuardConfig();
    error BadCaps(address token, uint256 accountCap, uint256 globalCap);
    error CapDecrease(address token);
    error NotGuardAdmin();
    error NotPendingGuardAdmin();
    error AllowlistInactive();
    error CapsInactive();
    error NotAllowlisted(address account);
    error AccountCapExceeded(address account, address token, uint256 netDeposited, uint256 cap);
    error GlobalCapExceeded(address token, uint256 total, uint256 cap);
    /// @notice G-01: `globalCap` would not cover `accountCap` for each of `allowlisted` addresses.
    error Oversubscribed(address token, uint256 accountCap, uint256 globalCap, uint256 allowlisted);
    /// @notice `openToPublic` while caps are active: lift them first.
    error CapsStillActive();

    constructor() {
        deployer = msg.sender;
    }

    /// @notice One-time wiring. Fixes the accepted tokens, the modules, the protocol addresses that can
    ///         never withdraw (deposits to them are refused) and the launch guard, then locks forever.
    /// @param blockedRecipients Protocol contracts other than modules and tokens, e.g. the oracle.
    /// @param guardAdmin_ Launch-guard admin (the owner's wallet or multisig). Zero: unguarded, and both cap
    ///        arrays must be empty. Otherwise the allowlist and the caps start active.
    /// @param accountCaps_ Per-account cap for each of `tokens`, same order, token base units (USDG 6 decimals,
    ///        stock tokens 18). Zero blocks deposits of that token until the cap is raised.
    /// @param globalCaps_ Global cap for each of `tokens`, same order; each at least the account cap. The allowlist
    ///        starts empty; each address added later needs one more account cap of global room (G-01).
    function setup(
        address[] calldata tokens,
        address[] calldata modules,
        address[] calldata blockedRecipients,
        address guardAdmin_,
        uint256[] calldata accountCaps_,
        uint256[] calldata globalCaps_
    ) external {
        if (msg.sender != deployer) revert NotDeployer();
        if (locked) revert AlreadySetUp();
        locked = true;
        for (uint256 i; i < tokens.length; ++i) {
            if (tokens[i] == address(0)) revert ZeroAddress();
            if (isToken[tokens[i]]) revert DuplicateToken(tokens[i]);
            isToken[tokens[i]] = true;
            _tokens.push(tokens[i]);
        }
        for (uint256 i; i < modules.length; ++i) {
            if (modules[i] == address(0)) revert ZeroAddress();
            isModule[modules[i]] = true;
        }
        for (uint256 i; i < blockedRecipients.length; ++i) {
            if (blockedRecipients[i] == address(0)) revert ZeroAddress();
            isBlockedRecipient[blockedRecipients[i]] = true;
        }
        emit Setup(tokens, modules, blockedRecipients);
        _setupGuard(tokens, guardAdmin_, accountCaps_, globalCaps_);
    }

    /// @dev The admin must be able to act: not the vault, a token, a module or a blocked protocol address.
    function _setupGuard(
        address[] calldata tokens,
        address admin,
        uint256[] calldata accountCaps_,
        uint256[] calldata globalCaps_
    ) internal {
        if (admin == address(0)) {
            if (accountCaps_.length != 0 || globalCaps_.length != 0) {
                revert BadGuardConfig();
            }
        } else {
            if (accountCaps_.length != tokens.length || globalCaps_.length != tokens.length) revert BadGuardConfig();
            if (admin == address(this) || isToken[admin] || isModule[admin] || isBlockedRecipient[admin]) {
                revert BadGuardConfig();
            }
            for (uint256 i; i < tokens.length; ++i) {
                if (accountCaps_[i] > globalCaps_[i]) revert BadCaps(tokens[i], accountCaps_[i], globalCaps_[i]);
                accountCap[tokens[i]] = accountCaps_[i];
                globalCap[tokens[i]] = globalCaps_[i];
            }
            guardAdmin = admin;
            allowlistActive = true;
            capsActive = true;
        }
        emit GuardSetup(admin, accountCaps_, globalCaps_);
    }

    /// @notice Deposit `amount` of `token` and credit `to`. Fee-on-transfer safe: credits the
    ///         amount that actually arrived. `to` may not be a module (modules only hold balances they
    ///         account for, internal audit I-1), the vault itself, a listed token or a blocked protocol
    ///         address such as the oracle (none of them can ever withdraw, R2-05): the deposit would be
    ///         stranded. Launch guard: while the allowlist is active both the caller and `to` must be
    ///         allowlisted; while caps are active `to`'s net deposits and the vault's holdings of `token`
    ///         must stay within their caps after the deposit.
    function deposit(address token, uint256 amount, address to) external nonReentrant returns (uint256 received) {
        if (!locked) revert NotSetUp();
        if (!isToken[token]) revert UnknownToken(token);
        _checkRecipient(to);
        if (amount == 0) revert ZeroAmount();
        if (allowlistActive) {
            if (!isAllowlisted[msg.sender]) revert NotAllowlisted(msg.sender);
            if (!isAllowlisted[to]) revert NotAllowlisted(to);
        }
        uint256 before = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        received = IERC20(token).balanceOf(address(this)) - before;
        if (received == 0) revert ZeroAmount();
        uint256 total = totalInternal[token] + received;
        if (capsActive) _useCaps(token, to, received, total);
        balanceOf[to][token] += received;
        totalInternal[token] = total;
        emit Deposited(msg.sender, to, token, received);
    }

    /// @notice Withdraw from the caller's own internal balance. The recipient checks are the deposit's (final
    ///         audit FA-06): not a module, the vault itself, a listed token or a blocked protocol address. None of
    ///         them can move the ERC-20s it receives (the vault would hold them without an internal balance), so the
    ///         tokens would be stranded for good. The launch guard never blocks a withdrawal: while caps are
    ///         active it only lowers the caller's `netDeposited` (never below zero).
    function withdraw(address token, uint256 amount, address to) external nonReentrant {
        _checkRecipient(to);
        if (amount == 0) revert ZeroAmount();
        uint256 bal = balanceOf[msg.sender][token];
        if (bal < amount) revert InsufficientBalance(msg.sender, token, bal, amount);
        unchecked {
            balanceOf[msg.sender][token] = bal - amount;
        }
        totalInternal[token] -= amount;
        if (capsActive) _releaseCaps(token, amount);
        IERC20(token).safeTransfer(to, amount);
        emit Withdrawn(msg.sender, to, token, amount);
    }

    /// @notice Let `module` debit the caller's internal balances (needed to trade, add liquidity
    ///         or post offers). Revocable at any time. While the allowlist is active only an allowlisted
    ///         caller may grant an approval (revoking is always allowed).
    function setApproval(address module, bool ok) external {
        if (!isModule[module]) revert NotModule(module);
        if (ok && allowlistActive && !isAllowlisted[msg.sender]) revert NotAllowlisted(msg.sender);
        approved[msg.sender][module] = ok;
        emit ModuleApproval(msg.sender, module, ok);
    }

    /// @dev Refuse a recipient that could never use what it receives: the zero address, a module, the vault itself,
    ///      a listed token or a blocked protocol address (deposits: I-1, R2-05; withdrawals: FA-06).
    function _checkRecipient(address to) internal view {
        if (to == address(0)) revert ZeroAddress();
        if (isModule[to]) revert ModuleRecipient(to);
        if (to == address(this) || isToken[to] || isBlockedRecipient[to]) revert ProtocolRecipient(to);
    }

    /// @inheritdoc IVelumVault
    function transferInternal(address token, address from, address to, uint256 amount) external {
        if (!isModule[msg.sender]) revert NotModule(msg.sender);
        if (from != msg.sender && !approved[from][msg.sender]) revert NotApproved(from, msg.sender);
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) return;
        uint256 bal = balanceOf[from][token];
        if (bal < amount) revert InsufficientBalance(from, token, bal, amount);
        unchecked {
            balanceOf[from][token] = bal - amount;
        }
        balanceOf[to][token] += amount;
        emit InternalTransfer(msg.sender, token, from, to, amount);
    }

    // ---------------------------------------------------------------- launch guard: caps

    /// @dev `total` is the vault's holdings of `token` after the deposit. Both caps are checked before anything
    ///      is written; `to`'s net deposits only grow here. The account cap is checked first: since G-01 the global
    ///      check cannot fail once it passes (total <= sum of netDeposited <= accountCap × allowlistedCount <=
    ///      globalCap, and only allowlisted accounts have net deposits); it is kept as a backstop.
    function _useCaps(address token, address to, uint256 received, uint256 total) internal {
        uint256 used = netDeposited[to][token] + received;
        uint256 cap = accountCap[token];
        if (used > cap) revert AccountCapExceeded(to, token, used, cap);
        cap = globalCap[token];
        if (total > cap) revert GlobalCapExceeded(token, total, cap);
        netDeposited[to][token] = used;
    }

    /// @dev Saturating: a withdrawal never reverts here, and withdrawing more than was deposited (profits, keeper
    ///      rewards) leaves zero, not credit.
    function _releaseCaps(address token, uint256 amount) internal {
        uint256 used = netDeposited[msg.sender][token];
        if (used == 0) return;
        unchecked {
            netDeposited[msg.sender][token] = used > amount ? used - amount : 0;
        }
    }

    // ---------------------------------------------------------------- launch guard: admin

    /// @notice Guard admin: allowlist `accounts` (already listed ones are skipped). There is no removal. While caps
    ///         are active every token's global cap must cover the account cap of every allowlisted address,
    ///         the new ones included (G-01): raise the global caps first.
    function addToAllowlist(address[] calldata accounts) external {
        _onlyGuardAdmin();
        if (!allowlistActive) revert AllowlistInactive();
        uint256 count = allowlistedCount;
        uint256 before = count;
        for (uint256 i; i < accounts.length; ++i) {
            address a = accounts[i];
            if (a == address(0)) revert ZeroAddress();
            if (isAllowlisted[a]) continue;
            isAllowlisted[a] = true;
            ++count;
            emit Allowlisted(a);
        }
        if (count == before) return;
        allowlistedCount = count;
        if (capsActive) {
            for (uint256 i; i < _tokens.length; ++i) {
                address t = _tokens[i];
                _checkRoom(t, accountCap[t], globalCap[t], count);
            }
        }
    }

    /// @notice Guard admin: raise `token`'s caps (base units). Neither cap may go down, the account cap may not
    ///         exceed the global cap, and the global cap must cover the account cap of every allowlisted address
    ///         (G-01).
    function raiseCaps(address token, uint256 newAccountCap, uint256 newGlobalCap) external {
        _onlyGuardAdmin();
        if (!capsActive) revert CapsInactive();
        if (!isToken[token]) revert UnknownToken(token);
        if (newAccountCap < accountCap[token] || newGlobalCap < globalCap[token]) revert CapDecrease(token);
        if (newAccountCap > newGlobalCap) revert BadCaps(token, newAccountCap, newGlobalCap);
        _checkRoom(token, newAccountCap, newGlobalCap, allowlistedCount);
        accountCap[token] = newAccountCap;
        globalCap[token] = newGlobalCap;
        emit CapsRaised(token, newAccountCap, newGlobalCap);
    }

    /// @dev G-01: `globalCap >= accountCap × count`, written without the multiplication so it cannot overflow.
    ///      Caps are only active while the allowlist is (`openToPublic` needs the caps lifted), so `count` is the
    ///      number of accounts that can hold net deposits.
    function _checkRoom(address token, uint256 acc, uint256 glob, uint256 count) internal pure {
        if (count != 0 && acc > glob / count) revert Oversubscribed(token, acc, glob, count);
    }

    /// @notice Guard admin: remove the allowlist forever. Only once the caps are lifted (`liftCaps`): caps without
    ///         an allowlist would make the global cap room anyone could fill (G-01). This always retires the guard.
    function openToPublic() external {
        _onlyGuardAdmin();
        if (!allowlistActive) revert AllowlistInactive();
        if (capsActive) revert CapsStillActive();
        allowlistActive = false;
        emit OpenedToPublic();
        _retireIfInert();
    }

    /// @notice Guard admin: remove the caps forever. The allowlist keeps applying until `openToPublic`.
    function liftCaps() external {
        _onlyGuardAdmin();
        if (!capsActive) revert CapsInactive();
        capsActive = false;
        emit CapsLifted();
        _retireIfInert();
    }

    /// @notice Guard admin: propose `newAdmin` as the next admin; it takes over with `acceptGuardAdmin`. Zero
    ///         cancels a pending proposal.
    function transferGuardAdmin(address newAdmin) external {
        _onlyGuardAdmin();
        pendingGuardAdmin = newAdmin;
        emit GuardAdminTransferStarted(msg.sender, newAdmin);
    }

    function acceptGuardAdmin() external {
        if (msg.sender != pendingGuardAdmin || msg.sender == address(0)) revert NotPendingGuardAdmin();
        emit GuardAdminTransferred(guardAdmin, msg.sender);
        guardAdmin = msg.sender;
        pendingGuardAdmin = address(0);
    }

    function _onlyGuardAdmin() internal view {
        if (msg.sender != guardAdmin || msg.sender == address(0)) revert NotGuardAdmin();
    }

    /// @dev Once both switches are off the admin has nothing left to do: clear the role (and any pending handover).
    function _retireIfInert() internal {
        if (allowlistActive || capsActive) return;
        emit GuardAdminTransferred(guardAdmin, address(0));
        guardAdmin = address(0);
        pendingGuardAdmin = address(0);
    }

    // ---------------------------------------------------------------- launch guard: views

    /// @notice True while the allowlist or the caps (or both) are active.
    function guarded() external view returns (bool) {
        return allowlistActive || capsActive;
    }

    /// @notice Whether `account` passes the allowlist now (always true once open to the public).
    function isAllowed(address account) public view returns (bool) {
        return !allowlistActive || isAllowlisted[account];
    }

    /// @notice The most `account` can deposit of `token` for itself right now: zero if the vault is not set up,
    ///         the token is not listed, `account` can never receive a deposit or is not allowed; unlimited
    ///         (`type(uint256).max`) once caps are lifted; otherwise what is left under both caps.
    function depositLimit(address account, address token) external view returns (uint256) {
        if (!locked || !isToken[token] || !isAllowed(account)) return 0;
        if (account == address(0) || isModule[account] || account == address(this) || isToken[account]) return 0;
        if (isBlockedRecipient[account]) return 0;
        if (!capsActive) return type(uint256).max;
        uint256 cap = accountCap[token];
        uint256 used = netDeposited[account][token];
        uint256 accountLeft = used < cap ? cap - used : 0;
        cap = globalCap[token];
        used = totalInternal[token];
        uint256 globalLeft = used < cap ? cap - used : 0;
        return accountLeft < globalLeft ? accountLeft : globalLeft;
    }
}
