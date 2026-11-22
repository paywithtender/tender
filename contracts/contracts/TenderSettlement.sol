// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice Minimal slice of Uniswap's canonical Permit2 (0x000000000022D473030F116dDEE9F6B43aC78BA3).
interface IPermit2 {
    struct TokenPermissions {
        address token;
        uint256 amount;
    }

    struct PermitTransferFrom {
        TokenPermissions permitted;
        uint256 nonce;
        uint256 deadline;
    }

    struct SignatureTransferDetails {
        address to;
        uint256 requestedAmount;
    }

    function permitWitnessTransferFrom(
        PermitTransferFrom calldata permit,
        SignatureTransferDetails calldata transferDetails,
        address owner,
        bytes32 witness,
        string calldata witnessTypeString,
        bytes calldata signature
    ) external;

    function approve(address token, address spender, uint160 amount, uint48 expiration) external;
}

/// @title TenderSettlement
/// @notice Lets an x402 payer pay a USDG price with any token. In one transaction it pulls the payer's
///         token with a Permit2 witness signature, swaps it to USDG through an allowlisted router,
///         pays the merchant exactly the quoted USDG amount, takes the fee in USDG, and refunds
///         any unused input token (and any surplus USDG) to the payer. USDG itself is paid directly, no swap.
/// @dev    Fee = whatever the payer signed, which must be at least the protocol minimum (0.5% for swaps,
///         0 for USDG and exempt tokens) and at most that minimum plus `maxGasFee`. The facilitator prices
///         the gas part into each quote, so the payer covers the cost of settling their own payment.
/// @dev    The payer's signature binds merchant, USDG amount, fee and resource, so a relayer can't redirect
///         funds. The payer's worst case is capped by the max input amount they signed. The contract holds
///         no balances between transactions.
contract TenderSettlement is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice What the payer agrees to, signed as the Permit2 witness.
    struct Payment {
        address merchant; // receives exactly `amountOut` USDG
        uint256 amountOut; // USDG the merchant gets (6 decimals)
        uint256 fee; // USDG the protocol gets on top
        bytes32 resource; // keccak256 of the x402 resource URL, ties the payment to one request
    }

    bytes32 public constant PAYMENT_TYPEHASH =
        keccak256("Payment(address merchant,uint256 amountOut,uint256 fee,bytes32 resource)");

    string public constant WITNESS_TYPE_STRING =
        "Payment witness)Payment(address merchant,uint256 amountOut,uint256 fee,bytes32 resource)TokenPermissions(address token,uint256 amount)";

    uint256 public constant MAX_FEE_BPS = 100; // hard cap: 1%

    IPermit2 public immutable permit2;
    IERC20 public immutable usdg;

    address public treasury;
    uint16 public feeBps = 50; // 0.5%
    uint256 public maxAmountOut = 1_000e6; // 1,000 USDG per payment to start
    uint256 public maxGasFee = 1e6; // the gas part of a fee can never exceed 1 USDG
    bool public paused;

    mapping(address => bool) public relayers; // facilitator hot wallets allowed to settle
    mapping(address => bool) public routers; // allowlisted swap routers
    mapping(address => bool) public routerUsesPermit2; // true for Universal Router style routers
    mapping(address => bool) public feeExempt; // input tokens that pay no fee (e.g. the Tender token)

    event Settled(
        address indexed payer,
        address indexed merchant,
        address indexed tokenIn,
        uint256 amountIn,
        uint256 amountOut,
        uint256 fee,
        bytes32 resource
    );
    event RelayerSet(address indexed relayer, bool allowed);
    event RouterSet(address indexed router, bool allowed, bool usesPermit2);
    event FeeExemptSet(address indexed token, bool exempt);
    event FeeBpsSet(uint16 feeBps);
    event TreasurySet(address treasury);
    event MaxAmountOutSet(uint256 maxAmountOut);
    event MaxGasFeeSet(uint256 maxGasFee);
    event PausedSet(bool paused);

    error NotRelayer();
    error IsPaused();
    error RouterNotAllowed();
    error BadToken();
    error BadMerchant();
    error AmountTooLarge();
    error FeeBelowMinimum(uint256 minimum, uint256 got);
    error FeeAboveMaximum(uint256 maximum, uint256 got);
    error InsufficientOutput(uint256 needed, uint256 got);
    error SwapFailed(bytes reason);
    error FeeTooHigh();
    error ZeroAddress();

    modifier onlyRelayer() {
        if (!relayers[msg.sender]) revert NotRelayer();
        _;
    }

    constructor(address owner_, IPermit2 permit2_, IERC20 usdg_, address treasury_) Ownable(owner_) {
        if (address(permit2_) == address(0) || address(usdg_) == address(0) || treasury_ == address(0)) {
            revert ZeroAddress();
        }
        permit2 = permit2_;
        usdg = usdg_;
        treasury = treasury_;
    }

    // ------------------------------------------------------------------ views

    /// @notice Minimum fee (protocol part) for a payment. The facilitator adds the gas part on top.
    function quoteFee(address tokenIn, uint256 amountOut) public view returns (uint256) {
        if (tokenIn == address(usdg) || feeExempt[tokenIn]) return 0;
        return (amountOut * feeBps + 9_999) / 10_000; // round up
    }

    function hashPayment(Payment calldata p) public pure returns (bytes32) {
        return keccak256(abi.encode(PAYMENT_TYPEHASH, p.merchant, p.amountOut, p.fee, p.resource));
    }

    // ------------------------------------------------------------------ settle

    /// @param permit     Permit2 transfer the payer signed (token = input token, amount = max input)
    /// @param payer      The signer and owner of the input tokens
    /// @param payment    Witness data the payer signed
    /// @param signature  Payer's Permit2 witness signature
    /// @param router     Allowlisted router to execute `swapData` on
    /// @param swapData   Router calldata that swaps the input token to USDG with this contract as recipient
    function settle(
        IPermit2.PermitTransferFrom calldata permit,
        address payer,
        Payment calldata payment,
        bytes calldata signature,
        address router,
        bytes calldata swapData
    ) external onlyRelayer nonReentrant returns (uint256 amountInUsed) {
        if (paused) revert IsPaused();

        address tokenIn = permit.permitted.token;
        if (tokenIn == address(0)) revert BadToken();
        if (payment.merchant == address(0) || payment.merchant == address(this)) revert BadMerchant();
        if (payment.amountOut == 0 || payment.amountOut > maxAmountOut) revert AmountTooLarge();

        uint256 minFee = quoteFee(tokenIn, payment.amountOut);
        if (payment.fee < minFee) revert FeeBelowMinimum(minFee, payment.fee);
        if (payment.fee > minFee + maxGasFee) revert FeeAboveMaximum(minFee + maxGasFee, payment.fee);

        uint256 needed = payment.amountOut + payment.fee;
        amountInUsed = tokenIn == address(usdg)
            ? _settleUsdg(permit, payer, payment, signature, needed)
            : _settleSwap(permit, payer, payment, signature, router, swapData, needed);

        emit Settled(payer, payment.merchant, tokenIn, amountInUsed, payment.amountOut, payment.fee, payment.resource);
    }

    /// @dev USDG in: pull exactly price + fee, no swap.
    function _settleUsdg(
        IPermit2.PermitTransferFrom calldata permit,
        address payer,
        Payment calldata payment,
        bytes calldata signature,
        uint256 needed
    ) internal returns (uint256) {
        uint256 before = usdg.balanceOf(address(this));
        permit2.permitWitnessTransferFrom(
            permit,
            IPermit2.SignatureTransferDetails({to: address(this), requestedAmount: needed}),
            payer,
            hashPayment(payment),
            WITNESS_TYPE_STRING,
            signature
        );
        uint256 got = usdg.balanceOf(address(this)) - before;
        if (got < needed) revert InsufficientOutput(needed, got);
        usdg.safeTransfer(payment.merchant, payment.amountOut);
        if (payment.fee > 0) usdg.safeTransfer(treasury, payment.fee);
        return needed;
    }

    /// @dev Any other token in: pull the signed max, swap to USDG, pay out, refund the rest.
    function _settleSwap(
        IPermit2.PermitTransferFrom calldata permit,
        address payer,
        Payment calldata payment,
        bytes calldata signature,
        address router,
        bytes calldata swapData,
        uint256 needed
    ) internal returns (uint256) {
        if (!routers[router]) revert RouterNotAllowed();
        IERC20 tIn = IERC20(permit.permitted.token);
        uint256 inBefore = tIn.balanceOf(address(this));
        uint256 usdgBefore = usdg.balanceOf(address(this));

        // 1. Pull the payer's max input. Permit2 checks the signature over permit + witness.
        permit2.permitWitnessTransferFrom(
            permit,
            IPermit2.SignatureTransferDetails({to: address(this), requestedAmount: permit.permitted.amount}),
            payer,
            hashPayment(payment),
            WITNESS_TYPE_STRING,
            signature
        );
        uint256 received = tIn.balanceOf(address(this)) - inBefore;

        // 2. Swap through the router, approving only what was received, only for this call.
        _approveRouter(tIn, router, received);
        (bool ok, bytes memory ret) = router.call(swapData);
        if (!ok) revert SwapFailed(ret);
        _revokeRouter(tIn, router);

        // 3. Check output and pay out.
        uint256 usdgOut = usdg.balanceOf(address(this)) - usdgBefore;
        if (usdgOut < needed) revert InsufficientOutput(needed, usdgOut);
        usdg.safeTransfer(payment.merchant, payment.amountOut);
        if (payment.fee > 0) usdg.safeTransfer(treasury, payment.fee);
        if (usdgOut > needed) usdg.safeTransfer(payer, usdgOut - needed); // positive slippage goes back to the payer

        // 4. Refund unused input token.
        uint256 leftover = tIn.balanceOf(address(this)) - inBefore;
        if (leftover > 0) tIn.safeTransfer(payer, leftover);
        return received - leftover;
    }

    function _approveRouter(IERC20 token, address router, uint256 amount) internal {
        if (routerUsesPermit2[router]) {
            token.forceApprove(address(permit2), type(uint256).max);
            permit2.approve(address(token), router, uint160(amount), uint48(block.timestamp));
        } else {
            token.forceApprove(router, amount);
        }
    }

    function _revokeRouter(IERC20 token, address router) internal {
        if (routerUsesPermit2[router]) {
            permit2.approve(address(token), router, 0, uint48(block.timestamp));
        } else {
            token.forceApprove(router, 0);
        }
    }

    // ------------------------------------------------------------------ admin

    function setRelayer(address relayer, bool allowed) external onlyOwner {
        relayers[relayer] = allowed;
        emit RelayerSet(relayer, allowed);
    }

    function setRouter(address router, bool allowed, bool usesPermit2) external onlyOwner {
        routers[router] = allowed;
        routerUsesPermit2[router] = usesPermit2;
        emit RouterSet(router, allowed, usesPermit2);
    }

    function setFeeExempt(address token, bool exempt) external onlyOwner {
        feeExempt[token] = exempt;
        emit FeeExemptSet(token, exempt);
    }

    function setFeeBps(uint16 bps) external onlyOwner {
        if (bps > MAX_FEE_BPS) revert FeeTooHigh();
        feeBps = bps;
        emit FeeBpsSet(bps);
    }

    function setTreasury(address t) external onlyOwner {
        if (t == address(0)) revert ZeroAddress();
        treasury = t;
        emit TreasurySet(t);
    }

    function setMaxAmountOut(uint256 m) external onlyOwner {
        maxAmountOut = m;
        emit MaxAmountOutSet(m);
    }

    function setMaxGasFee(uint256 m) external onlyOwner {
        maxGasFee = m;
        emit MaxGasFeeSet(m);
    }

    function setPaused(bool p) external onlyOwner {
        paused = p;
        emit PausedSet(p);
    }

    /// @notice Recover tokens sent here by mistake. The contract never holds funds between settlements.
    function sweep(IERC20 token, address to, uint256 amount) external onlyOwner {
        token.safeTransfer(to, amount);
    }
}
