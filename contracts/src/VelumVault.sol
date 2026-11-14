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
/// @dev No owner, no pause, no upgrade. The deployer calls `setup` exactly once to fix the token
///      list and the module set; after that nothing can be changed by anyone.
contract VelumVault is IVelumVault, ReentrancyGuard {
    using SafeERC20 for IERC20;

    address public immutable deployer;
    bool public locked;

    mapping(address token => bool) public isToken;
    mapping(address module => bool) public isModule;
    mapping(address account => mapping(address token => uint256)) public balanceOf;
    /// @notice Sum of all internal balances per token. Always equals what the vault received
    ///         minus what it paid out, so it never exceeds the vault's token holdings.
    mapping(address token => uint256) public totalInternal;
    mapping(address account => mapping(address module => bool)) public approved;

    event Setup(address[] tokens, address[] modules);
    /// @notice Public deposit ("shield" in the product). `amount` is what actually arrived.
    event Deposited(address indexed from, address indexed to, address indexed token, uint256 amount);
    /// @notice Public withdrawal ("unshield" in the product).
    event Withdrawn(address indexed from, address indexed to, address indexed token, uint256 amount);
    event ModuleApproval(address indexed account, address indexed module, bool approved);
    event InternalTransfer(
        address indexed module, address indexed token, address indexed from, address to, uint256 amount
    );

    error NotDeployer();
    error AlreadySetUp();
    error NotSetUp();
    error ZeroAddress();
    error ZeroAmount();
    error UnknownToken(address token);
    error NotModule(address caller);
    error NotApproved(address account, address module);
    error InsufficientBalance(address account, address token, uint256 balance, uint256 needed);

    constructor() {
        deployer = msg.sender;
    }

    /// @notice One-time wiring. Fixes the accepted tokens and the modules, then locks forever.
    function setup(address[] calldata tokens, address[] calldata modules) external {
        if (msg.sender != deployer) revert NotDeployer();
        if (locked) revert AlreadySetUp();
        locked = true;
        for (uint256 i; i < tokens.length; ++i) {
            if (tokens[i] == address(0)) revert ZeroAddress();
            isToken[tokens[i]] = true;
        }
        for (uint256 i; i < modules.length; ++i) {
            if (modules[i] == address(0)) revert ZeroAddress();
            isModule[modules[i]] = true;
        }
        emit Setup(tokens, modules);
    }

    /// @notice Deposit `amount` of `token` and credit `to`. Fee-on-transfer safe: credits the
    ///         amount that actually arrived.
    function deposit(address token, uint256 amount, address to) external nonReentrant returns (uint256 received) {
        if (!locked) revert NotSetUp();
        if (!isToken[token]) revert UnknownToken(token);
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        uint256 before = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        received = IERC20(token).balanceOf(address(this)) - before;
        if (received == 0) revert ZeroAmount();
        balanceOf[to][token] += received;
        totalInternal[token] += received;
        emit Deposited(msg.sender, to, token, received);
    }

    /// @notice Withdraw from the caller's own internal balance to any address.
    function withdraw(address token, uint256 amount, address to) external nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        uint256 bal = balanceOf[msg.sender][token];
        if (bal < amount) revert InsufficientBalance(msg.sender, token, bal, amount);
        unchecked {
            balanceOf[msg.sender][token] = bal - amount;
        }
        totalInternal[token] -= amount;
        IERC20(token).safeTransfer(to, amount);
        emit Withdrawn(msg.sender, to, token, amount);
    }

    /// @notice Let `module` debit the caller's internal balances (needed to trade, add liquidity
    ///         or post offers). Revocable at any time.
    function setApproval(address module, bool ok) external {
        if (!isModule[module]) revert NotModule(module);
        approved[msg.sender][module] = ok;
        emit ModuleApproval(msg.sender, module, ok);
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
}
