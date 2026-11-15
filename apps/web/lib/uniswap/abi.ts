/**
 * The Uniswap contracts the web calls for real spot trades on Robinhood Chain mainnet (addresses: packages/config
 * uniswap-mainnet.json): the two quoters, Permit2 and the Universal Router, with every custom error a swap can revert
 * with (decoded into a sentence by lib/onchain/errors.ts). Signatures follow the deployed versions: Universal Router
 * 2.1.2 (v2.1.1+ swap structs carry minHopPriceX36), v4-periphery V4Quoter, v3 QuoterV2, canonical Permit2.
 */
import { parseAbi } from 'viem';

/** Errors the Universal Router, its v3/v4 routers, Permit2 and the pools can revert a swap with. */
const UNI_ERRORS = [
  'error ExecutionFailed(uint256 commandIndex, bytes message)',
  'error TransactionDeadlinePassed()',
  'error LengthMismatch()',
  'error InvalidCommandType(uint256 commandType)',
  'error V3TooLittleReceived()',
  'error V3TooMuchRequested()',
  'error V3InvalidSwap()',
  'error V3InvalidAmountOut()',
  'error V3InvalidCaller()',
  'error V4TooLittleReceived(uint256 minAmountOutReceived, uint256 amountReceived)',
  'error V4TooMuchRequested(uint256 maxAmountInRequested, uint256 amountRequested)',
  'error V3TooLittleReceivedPerHop(uint256 hopIndex, uint256 minPrice, uint256 price)',
  'error V4TooLittleReceivedPerHop(uint256 hopIndex, uint256 minPrice, uint256 price)',
  'error InsufficientToken()',
  'error AllowanceExpired(uint256 deadline)',
  'error InsufficientAllowance(uint256 amount)',
  'error ContractLocked()',
  'error DeltaNotNegative(address currency)',
  'error DeltaNotPositive(address currency)',
  'error PriceLimitAlreadyExceeded(uint160 sqrtPriceCurrentX96, uint160 sqrtPriceLimitX96)',
  'error PoolNotInitialized()',
  'error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)',
  'error ERC20InsufficientAllowance(address spender, uint256 allowance, uint256 needed)',
] as const;

export const UNI_ERRORS_ABI = parseAbi(UNI_ERRORS);

export const QUOTER_V2_ABI = parseAbi([
  'function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
]);

export const V4_QUOTER_ABI = parseAbi([
  'struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }',
  'struct QuoteExactSingleParams { PoolKey poolKey; bool zeroForOne; uint128 exactAmount; bytes hookData; }',
  'function quoteExactInputSingle(QuoteExactSingleParams params) returns (uint256 amountOut, uint256 gasEstimate)',
]);

export const PERMIT2_ABI = parseAbi([
  'function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)',
  'function approve(address token, address spender, uint160 amount, uint48 expiration)',
  'event Approval(address indexed owner, address indexed token, address indexed spender, uint160 amount, uint48 expiration)',
  ...UNI_ERRORS,
]);

export const UNIVERSAL_ROUTER_ABI = parseAbi(['function execute(bytes commands, bytes[] inputs, uint256 deadline) payable', ...UNI_ERRORS]);

export const ERC20_TRANSFER_ABI = parseAbi(['event Transfer(address indexed from, address indexed to, uint256 value)']);
