/**
 * Human-readable ABIs of the Phase 3 contracts (contracts/src), for viem's parseAbi in apps/workers and
 * apps/api (this package has no dependencies, so it ships the strings and the apps parse them). Only what
 * the workers and the API call or index. The end-to-end test compares every event here with the forge
 * artifacts (apps/workers/src/onchain/e2e.test.ts); events a later contract version adds and this list
 * does not know are stored raw by the indexer and never break it.
 */

export const VAULT_ABI = [
  'event Setup(address[] tokens, address[] modules, address[] blockedRecipients)',
  'event Deposited(address indexed from, address indexed to, address indexed token, uint256 amount)',
  'event Withdrawn(address indexed from, address indexed to, address indexed token, uint256 amount)',
  'event ModuleApproval(address indexed account, address indexed module, bool approved)',
  'event InternalTransfer(address indexed module, address indexed token, address indexed from, address to, uint256 amount)',
  // Launch guard (guarded mainnet beta): allowlist, deposit caps, one-way opening, admin handover.
  'event GuardSetup(address indexed admin, uint256[] accountCaps, uint256[] globalCaps)',
  'event Allowlisted(address indexed account)',
  'event CapsRaised(address indexed token, uint256 accountCap, uint256 globalCap)',
  'event OpenedToPublic()',
  'event CapsLifted()',
  'event GuardAdminTransferStarted(address indexed admin, address indexed pendingAdmin)',
  'event GuardAdminTransferred(address indexed previousAdmin, address indexed newAdmin)',
  'function guardAdmin() view returns (address)',
  'function allowlistActive() view returns (bool)',
  'function capsActive() view returns (bool)',
  'function isAllowlisted(address account) view returns (bool)',
  'function accountCap(address token) view returns (uint256)',
  'function globalCap(address token) view returns (uint256)',
  'function depositLimit(address account, address token) view returns (uint256)',
  'function deposit(address token, uint256 amount, address to) returns (uint256 received)',
  'function withdraw(address token, uint256 amount, address to)',
  'function setApproval(address module, bool ok)',
  'function balanceOf(address account, address token) view returns (uint256)',
] as const;

export const ORACLE_ABI = [
  'event Setup(address[] tokens, address[] feeds, address relayer, address sequencerFeed)',
  'event PriceRelayed(address indexed token, uint256 price, uint256 effectivePrice, uint256 observedAt, uint256 timestamp)',
  // observedAt: when the relay observed the prices (chain time); the push must land within MAX_PUSH_DELAY (M-1).
  'function pushPrices(address[] tokens, uint256[] prices, uint256 observedAt)',
  'function MAX_PUSH_DELAY() view returns (uint256)',
  'function relayer() view returns (address)',
  'function sources(address token) view returns (address feed, uint8 feedDecimals, uint128 minPrice, uint128 maxPrice, bool configured)',
  // updatedAt: the newest push's observation time (the source timestamp); pushedAt: its block time.
  'function relayed(address token) view returns (uint128 price, uint64 updatedAt, uint64 pushedAt)',
  'function bands(address token) view returns (uint128 last, uint64 lastAt, uint64 lastValidAt)',
  'function sequencerStatus() view returns (bool up, bool ready)',
  'function price(address token) view returns (uint256)',
  'function lagging(address token) view returns (bool)',
  'function isDead(address token) view returns (bool)',
  'error NotRelayer()',
  'error UnknownToken(address token)',
  'error NotRelaySourced(address token)',
  'error NoPrice(address token)',
  'error StalePrice(address token, uint256 updatedAt)',
  'error PriceOutOfBounds(address token, uint256 price)',
  'error TooSoon(address token)',
  'error ObservedInFuture(uint256 observedAt)',
  'error PushExpired(uint256 observedAt)',
  'error StaleObservation(address token, uint256 observedAt)',
  'error LengthMismatch()',
] as const;

export const SPOT_ABI = [
  'event Setup(address[] stocks)',
  'event PoolChanged(address indexed stock, uint256 stockReserve, uint256 usdgReserve, uint256 totalShares)',
  'event LiquidityAdded(address indexed account, address indexed stock, uint256 stockAmount, uint256 usdgAmount, uint256 shares)',
  'event LiquidityRemoved(address indexed account, address indexed stock, uint256 stockAmount, uint256 usdgAmount, uint256 shares)',
  'event Swapped(address indexed account, address indexed tokenIn, address indexed tokenOut, uint256 amountIn, uint256 amountOut)',
  'function addLiquidity(address stock, uint256 maxStock, uint256 maxUsdg, uint256 minShares, uint256 deadline) returns (uint256 shares, uint256 stockIn, uint256 usdgIn)',
  'function removeLiquidity(address stock, uint256 shares, uint256 minStock, uint256 minUsdg, uint256 deadline) returns (uint256 stockOut, uint256 usdgOut)',
  'function swap(address tokenIn, address tokenOut, uint256 amountIn, uint256 minOut, uint256 deadline) returns (uint256 amountOut)',
] as const;

export const BOOK_ABI = [
  'event Setup(address perps, address[] markets)',
  'event OfferPosted(uint256 indexed id, address indexed maker, address indexed market, uint256 backing, uint256 largestFill, uint16 openSpreadBps, uint16 closeSpreadBps, uint64 expiry)',
  'event OfferFilled(uint256 indexed id, uint256 fillSize, uint256 makerMargin, uint256 backingLeft)',
  'event OfferWithdrawn(uint256 indexed id, address indexed maker, uint256 returned)',
  'function postOffer(address market, uint256 backing, uint256 largestFill, uint16 openSpreadBps, uint16 closeSpreadBps, uint64 expiry) returns (uint256 id)',
  'function withdrawOffer(uint256 id) returns (uint256 returned)',
] as const;

export const PERPS_ABI = [
  'event Setup(address[] markets, uint256[] oiCaps, address guardian)',
  'event PositionChanged(uint256 indexed id, address indexed market, uint8 indexed action, address taker, address maker, bool isLong, uint256 qty, uint256 entry, uint256 takerMargin, uint256 makerMargin, uint256 price)',
  'event PositionSettled(uint256 indexed id, uint256 exitPrice, int256 takerPnl, int256 takerFunding, uint256 fee, uint256 takerOut, uint256 makerOut)',
  'event Liquidated(uint256 indexed id, address indexed liquidator, bool takerSide, uint256 price, uint256 penalty, uint256 reward, uint256 shortfall)',
  'event FundingAdvanced(address indexed market, int256 rate, int256 index, uint256 timestamp)',
  'event InsuranceFunded(address indexed from, uint256 amount)',
  'event ForcedExitRequested(uint256 indexed id, address indexed requester, uint256 settleAfter)',
  'event ForcedExitSettled(uint256 indexed id, uint256 price, bool atEntryPrice)',
  'event BondRefundDeferred(address indexed account, uint256 amount)',
  'event BondClaimed(address indexed account, uint256 amount)',
  'event CloseOnlySet(address indexed market, bool closeOnly)',
  'event CoverClaimFiled(uint256 indexed epoch, address indexed account, uint256 amount)',
  'event CoverEpochSettled(uint256 indexed epoch, uint256 claimed, uint256 budget)',
  'event CoverPaid(uint256 indexed epoch, address indexed account, uint256 claim, uint256 paid)',
  'function open(uint256 offerId, address market, bool isLong, uint256 size, uint8 leverageHalf, uint256 priceLimit) returns (uint256 id)',
  'function close(uint256 id, uint256 priceLimit) returns (uint256 takerOut)',
  'function addMargin(uint256 id, uint256 amount)',
  'function requestForcedExit(uint256 id) payable',
  'function settleForcedExit(uint256 id)',
  'function liquidate(uint256 id) returns (uint256 reward)',
  'function isLiquidatable(uint256 id) view returns (bool)',
  'function advanceFunding(address market) returns (int256 index)',
  'function settleCoverEpoch(uint256 epoch) returns (uint256 budget)',
  'function claimCover(uint256 epoch, address account) returns (uint256 amount)',
  'function fundInsurance(uint256 amount)',
  'function getPosition(uint256 id) view returns ((address taker, address maker, address market, bool isLong, bool open, uint8 leverageHalf, uint16 closeSpreadBps, uint64 openedAt, uint64 exitRequestedAt, address exitRequester, uint256 qty, uint256 entry, uint256 takerMargin, uint256 makerMargin, int256 fundingIndexAtOpen))',
  'function markets(address market) view returns (bool enabled, uint256 oiCap, uint256 longOI, uint256 shortOI, int256 fundingIndex, int256 fundingRate, uint64 lastFundingUpdate)',
  'function takerClaimAt(uint256 id, uint256 price) view returns (int256)',
  'function insurance() view returns (uint256)',
  'function nextPositionId() view returns (uint256)',
  'function valueScale() view returns (uint256)',
  'function keeperRewardCap() view returns (uint256)',
  'function closeOnly(address market) view returns (bool)',
  'function guardian() view returns (address)',
  'function currentCoverEpoch() view returns (uint256)',
  'function coverClaims(uint256 epoch, address account) view returns (uint256)',
  'error NotOpen(uint256 id)',
  'error NotLiquidatable(uint256 id)',
  'error SequencerDown()',
  'error PriceLagging(address market)',
  'error StalePrice(address token, uint256 updatedAt)',
  'error TooEarly(uint256 settleAfter)',
  'error NotRequested(uint256 id)',
  'error UnknownMarket(address market)',
  'error EpochNotOver(uint256 epoch)',
  'error EpochSettled(uint256 epoch)',
  'error NothingToClaim()',
  'error PriceLimit(uint256 price, uint256 limit)',
  'error NoPriceLimit()',
  'error CloseOnly(address market)',
] as const;

export const ERC20_ABI = [
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function balanceOf(address account) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
] as const;

/** PerpsBase.Action, the indexed `action` of PositionChanged. */
export const PERPS_ACTIONS = ['open', 'close', 'add_margin', 'remove_margin', 'liquidate', 'forced_exit'] as const;
export type PerpsAction = (typeof PERPS_ACTIONS)[number];
