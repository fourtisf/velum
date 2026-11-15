/**
 * ABIs of the Phase 3 contracts (contracts/src) for the web: every function the web reads or sends, and
 * every custom error a user action can revert with (decoded into a sentence by lib/onchain/errors.ts).
 * packages/config/src/onchain-abi.ts carries what the workers and the API index; this is the web's
 * superset (removeMargin, offers, pools, quotes, launch-guard views, errors of every module). A unit test
 * checks each entry parses and that the shared events/functions agree with packages/config.
 */
import { parseAbi } from 'viem';

/** Errors shared by several contracts (oracle reads bubble up through perps, vault moves through every module). */
const SHARED_ERRORS = [
  'error ZeroAddress()',
  'error ZeroAmount()',
  'error UnknownToken(address token)',
  'error UnknownMarket(address market)',
  'error NotDeployer()',
  'error AlreadySetUp()',
  'error LengthMismatch()',
  'error ReentrancyGuardReentrantCall()',
  'error SafeERC20FailedOperation(address token)',
] as const;

export const VAULT_ABI = parseAbi([
  'function deposit(address token, uint256 amount, address to) returns (uint256 received)',
  'function withdraw(address token, uint256 amount, address to)',
  'function setApproval(address module, bool ok)',
  'function balanceOf(address account, address token) view returns (uint256)',
  'function approved(address account, address module) view returns (bool)',
  'function guarded() view returns (bool)',
  'function guardAdmin() view returns (address)',
  'function allowlistActive() view returns (bool)',
  'function capsActive() view returns (bool)',
  'function isAllowlisted(address account) view returns (bool)',
  'function isAllowed(address account) view returns (bool)',
  'function accountCap(address token) view returns (uint256)',
  'function globalCap(address token) view returns (uint256)',
  'function netDeposited(address account, address token) view returns (uint256)',
  'function depositLimit(address account, address token) view returns (uint256)',
  'event Deposited(address indexed from, address indexed to, address indexed token, uint256 amount)',
  'event Withdrawn(address indexed from, address indexed to, address indexed token, uint256 amount)',
  'event ModuleApproval(address indexed account, address indexed module, bool approved)',
  'error ModuleRecipient(address module)',
  'error ProtocolRecipient(address account)',
  'error NotModule(address caller)',
  'error NotApproved(address account, address module)',
  'error InsufficientBalance(address account, address token, uint256 balance, uint256 needed)',
  'error NotSetUp()',
  'error DuplicateToken(address token)',
  'error NotAllowlisted(address account)',
  'error AccountCapExceeded(address account, address token, uint256 netDeposited, uint256 cap)',
  'error GlobalCapExceeded(address token, uint256 total, uint256 cap)',
  ...SHARED_ERRORS,
]);

export const ORACLE_ABI = parseAbi([
  'function latest(address token) view returns (uint256 p, uint256 updatedAt)',
  'function lagging(address token) view returns (bool)',
  'function sequencerStatus() view returns (bool up, bool ready)',
  'error NoPrice(address token)',
  'error StalePrice(address token, uint256 updatedAt)',
  'error PriceOutOfBounds(address token, uint256 price)',
  'error NotRelaySourced(address token)',
  'error BadFeed(address feed)',
  ...SHARED_ERRORS,
]);

export const SPOT_ABI = parseAbi([
  'function swap(address tokenIn, address tokenOut, uint256 amountIn, uint256 minOut, uint256 deadline) returns (uint256 amountOut)',
  'function addLiquidity(address stock, uint256 maxStock, uint256 maxUsdg, uint256 minShares, uint256 deadline) returns (uint256 shares, uint256 stockIn, uint256 usdgIn)',
  'function removeLiquidity(address stock, uint256 shares, uint256 minStock, uint256 minUsdg, uint256 deadline) returns (uint256 stockOut, uint256 usdgOut)',
  'function getAmountOut(address tokenIn, address tokenOut, uint256 amountIn) view returns (uint256)',
  'function pools(address stock) view returns (uint256 stockReserve, uint256 usdgReserve, uint256 totalShares, bool exists)',
  'function sharesOf(address stock, address account) view returns (uint256)',
  'event Swapped(address indexed account, address indexed tokenIn, address indexed tokenOut, uint256 amountIn, uint256 amountOut)',
  'event LiquidityAdded(address indexed account, address indexed stock, uint256 stockAmount, uint256 usdgAmount, uint256 shares)',
  'event LiquidityRemoved(address indexed account, address indexed stock, uint256 stockAmount, uint256 usdgAmount, uint256 shares)',
  'error UnknownPool(address stock)',
  'error Expired()',
  'error SameToken()',
  'error NoLiquidity(address stock)',
  'error Slippage(uint256 got, uint256 min)',
  'error NoMinimum()',
  'error InsufficientShares(uint256 have, uint256 need)',
  ...SHARED_ERRORS,
]);

export const BOOK_ABI = parseAbi([
  'function postOffer(address market, uint256 backing, uint256 largestFill, uint16 openSpreadBps, uint16 closeSpreadBps, uint64 expiry) returns (uint256 id)',
  'function withdrawOffer(uint256 id) returns (uint256 returned)',
  'function offers(uint256 id) view returns (address maker, address market, uint256 backing, uint256 largestFill, uint16 openSpreadBps, uint16 closeSpreadBps, uint64 expiry, bool active)',
  'function nextOfferId() view returns (uint256)',
  'event OfferPosted(uint256 indexed id, address indexed maker, address indexed market, uint256 backing, uint256 largestFill, uint16 openSpreadBps, uint16 closeSpreadBps, uint64 expiry)',
  'event OfferWithdrawn(uint256 indexed id, address indexed maker, uint256 returned)',
  'error NotPerps()',
  'error BadOffer()',
  'error NotMaker()',
  'error OfferInactive(uint256 id)',
  'error OfferExpired(uint256 id)',
  'error WrongMarket(uint256 id)',
  'error FillTooLarge(uint256 fillSize, uint256 largestFill)',
  'error InsufficientBacking(uint256 backing, uint256 needed)',
  ...SHARED_ERRORS,
]);

export const PERPS_ABI = parseAbi([
  'function open(uint256 offerId, address market, bool isLong, uint256 size, uint8 leverageHalf, uint256 priceLimit) returns (uint256 id)',
  'function close(uint256 id, uint256 priceLimit) returns (uint256 takerOut)',
  'function addMargin(uint256 id, uint256 amount)',
  'function removeMargin(uint256 id, uint256 amount)',
  'function requestForcedExit(uint256 id) payable',
  'function settleForcedExit(uint256 id)',
  'function claimBond()',
  'function getPosition(uint256 id) view returns ((address taker, address maker, address market, bool isLong, bool open, uint8 leverageHalf, uint16 closeSpreadBps, uint64 openedAt, uint64 exitRequestedAt, address exitRequester, uint256 qty, uint256 entry, uint256 takerMargin, uint256 makerMargin, int256 fundingIndexAtOpen))',
  'function takerClaimAt(uint256 id, uint256 price) view returns (int256)',
  'function isLiquidatable(uint256 id) view returns (bool)',
  'function closeOnly(address market) view returns (bool)',
  'function markets(address market) view returns (bool enabled, uint256 oiCap, uint256 longOI, uint256 shortOI, int256 fundingIndex, int256 fundingRate, uint64 lastFundingUpdate)',
  'function valueScale() view returns (uint256)',
  'function minPositionSize() view returns (uint256)',
  'function bondRefunds(address account) view returns (uint256)',
  'function FORCED_EXIT_BOND() view returns (uint256)',
  'function FORCED_EXIT_DELAY() view returns (uint256)',
  'event PositionChanged(uint256 indexed id, address indexed market, uint8 indexed action, address taker, address maker, bool isLong, uint256 qty, uint256 entry, uint256 takerMargin, uint256 makerMargin, uint256 price)',
  'event PositionSettled(uint256 indexed id, uint256 exitPrice, int256 takerPnl, int256 takerFunding, uint256 fee, uint256 takerOut, uint256 makerOut)',
  'event Liquidated(uint256 indexed id, address indexed liquidator, bool takerSide, uint256 price, uint256 penalty, uint256 reward, uint256 shortfall)',
  'event ForcedExitRequested(uint256 indexed id, address indexed requester, uint256 settleAfter)',
  'event ForcedExitSettled(uint256 indexed id, uint256 price, bool atEntryPrice)',
  'event BondClaimed(address indexed account, uint256 amount)',
  'error BadLeverage(uint8 leverageHalf)',
  'error BadQuantity(uint256 qty)',
  'error OpenInterestCap(address market)',
  'error SelfTrade()',
  'error PriceLimit(uint256 price, uint256 limit)',
  'error NotOpen(uint256 id)',
  'error NotTaker()',
  'error NotParty()',
  'error BelowInitialMargin(int256 claim, uint256 required)',
  'error NotLiquidatable(uint256 id)',
  'error BadBond()',
  'error AlreadyRequested(uint256 id)',
  'error NotRequested(uint256 id)',
  'error TooEarly(uint256 settleAfter)',
  'error NothingToClaim()',
  'error RefundFailed()',
  'error PositionTooSmall(uint256 size, uint256 minSize)',
  'error ExceedsMargin(uint256 amount, uint256 margin)',
  'error CloseOnly(address market)',
  'error NotGuardian()',
  'error PriceLagging(address market)',
  'error SequencerDown()',
  'error EpochNotOver(uint256 epoch)',
  'error EpochSettled(uint256 epoch)',
  'error NoPriceLimit()',
  // Bubble up from the oracle, the maker book and the vault.
  'error NoPrice(address token)',
  'error StalePrice(address token, uint256 updatedAt)',
  'error OfferInactive(uint256 id)',
  'error OfferExpired(uint256 id)',
  'error WrongMarket(uint256 id)',
  'error FillTooLarge(uint256 fillSize, uint256 largestFill)',
  'error InsufficientBacking(uint256 backing, uint256 needed)',
  'error NotApproved(address account, address module)',
  'error InsufficientBalance(address account, address token, uint256 balance, uint256 needed)',
  ...SHARED_ERRORS,
]);

export const ERC20_ABI = parseAbi([
  'function decimals() view returns (uint8)',
  'function balanceOf(address account) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)',
  'error ERC20InsufficientAllowance(address spender, uint256 allowance, uint256 needed)',
]);

/** Every error any of the contracts above can revert with, for decoding a revert whatever contract raised it. */
export const ALL_ERRORS_ABI = [VAULT_ABI, ORACLE_ABI, SPOT_ABI, BOOK_ABI, PERPS_ABI, ERC20_ABI]
  .flat()
  .filter((x, i, all) => x.type === 'error' && all.findIndex((y) => y.type === 'error' && y.name === x.name) === i);

/** PerpsBase.Action (the indexed `action` of PositionChanged). */
export const PERPS_ACTION = { open: 0, close: 1, addMargin: 2, removeMargin: 3, liquidate: 4, forcedExit: 5 } as const;
