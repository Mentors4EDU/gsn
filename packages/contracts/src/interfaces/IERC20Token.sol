// SPDX-License-Identifier: MIT
// OpenZeppelin Contracts v4.4.1 (token/ERC20/IERC20.sol)

pragma solidity >=0.7.6;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * Renamed to avoid conflict with OZ namespace. Includes IERC20, ERC20Metadata and 'mint(uint256)'.
 * @dev Interface of the ERC20 standard as defined in the EIP.
 */
interface IERC20Token is IERC20, IERC20Metadata{
    function mint(uint256 amount) external;
}
