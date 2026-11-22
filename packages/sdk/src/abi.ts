import { parseAbi } from "viem";

export const tenderSettlementAbi = parseAbi([
  "struct TokenPermissions { address token; uint256 amount; }",
  "struct PermitTransferFrom { TokenPermissions permitted; uint256 nonce; uint256 deadline; }",
  "struct Payment { address merchant; uint256 amountOut; uint256 fee; bytes32 resource; }",
  "function settle(PermitTransferFrom permit, address payer, Payment payment, bytes signature, address router, bytes swapData) returns (uint256)",
  "function quoteFee(address tokenIn, uint256 amountOut) view returns (uint256)",
  "function routers(address) view returns (bool)",
  "function routerUsesPermit2(address) view returns (bool)",
  "function relayers(address) view returns (bool)",
  "function maxAmountOut() view returns (uint256)",
  "function maxGasFee() view returns (uint256)",
  "function paused() view returns (bool)",
  "event Settled(address indexed payer, address indexed merchant, address indexed tokenIn, uint256 amountIn, uint256 amountOut, uint256 fee, bytes32 resource)",
  "error NotRelayer()",
  "error IsPaused()",
  "error RouterNotAllowed()",
  "error BadToken()",
  "error BadMerchant()",
  "error AmountTooLarge()",
  "error FeeBelowMinimum(uint256 minimum, uint256 got)",
  "error FeeAboveMaximum(uint256 maximum, uint256 got)",
  "error InsufficientOutput(uint256 needed, uint256 got)",
  "error SwapFailed(bytes reason)",
  // Permit2 errors bubble up through settle
  "error InvalidNonce()",
  "error SignatureExpired(uint256 signatureDeadline)",
  "error InvalidSignature()",
  "error InvalidSigner()",
  "error InvalidAmount(uint256 maxAmount)",
]);

export const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
]);

export const eip3009Abi = parseAbi([
  "function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)",
  "function authorizationState(address authorizer, bytes32 nonce) view returns (bool)",
]);

export const permit2Abi = parseAbi([
  "function nonceBitmap(address owner, uint256 wordPos) view returns (uint256)",
]);
