// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

contract MockERC20 is ERC20 {
    uint8 private immutable _dec;

    constructor(string memory n, string memory s, uint8 d) ERC20(n, s) {
        _dec = d;
    }

    function decimals() public view override returns (uint8) {
        return _dec;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @notice USDG stand-in with EIP-3009 transferWithAuthorization (domain "Global Dollar", version "1").
contract MockUSDG is MockERC20, EIP712 {
    bytes32 public constant TRANSFER_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );
    mapping(address => mapping(bytes32 => bool)) public authorizationState;

    constructor() MockERC20("Global Dollar", "USDG", 6) EIP712("Global Dollar", "1") {}

    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        require(block.timestamp > validAfter && block.timestamp < validBefore, "auth time");
        require(!authorizationState[from][nonce], "auth used");
        bytes32 digest = _hashTypedDataV4(
            keccak256(abi.encode(TRANSFER_WITH_AUTHORIZATION_TYPEHASH, from, to, value, validAfter, validBefore, nonce))
        );
        require(ECDSA.recover(digest, v, r, s) == from, "auth sig");
        authorizationState[from][nonce] = true;
        _transfer(from, to, value);
    }
}

interface IAllowanceTransfer {
    function transferFrom(address from, address to, uint160 amount, address token) external;
}

/// @notice Fake exact-output router: pays `amountOut` USDG for `amountOut * num / den` of tokenIn.
contract MockRouter {
    MockERC20 public immutable usdg;
    address public immutable permit2;
    uint256 public num;
    uint256 public den;
    uint256 public shortfall; // USDG withheld from the output, to simulate bad fills

    constructor(MockERC20 usdg_, address permit2_) {
        usdg = usdg_;
        permit2 = permit2_;
    }

    function setPrice(uint256 n, uint256 d) external {
        num = n;
        den = d;
    }

    function setShortfall(uint256 s) external {
        shortfall = s;
    }

    function swapExactOut(address tokenIn, uint256 amountOut, uint256 amountInMax, address recipient, bool viaPermit2)
        external
    {
        uint256 amountIn = (amountOut * num) / den;
        require(amountIn <= amountInMax, "too much input");
        if (viaPermit2) {
            IAllowanceTransfer(permit2).transferFrom(msg.sender, address(this), uint160(amountIn), tokenIn);
        } else {
            IERC20(tokenIn).transferFrom(msg.sender, address(this), amountIn);
        }
        usdg.mint(recipient, amountOut - shortfall);
    }

    /// @notice Tries to pull more than approved.
    function greedy(address tokenIn, uint256 amount) external {
        IERC20(tokenIn).transferFrom(msg.sender, address(this), amount);
    }
}
