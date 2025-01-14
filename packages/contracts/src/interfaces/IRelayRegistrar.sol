//SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.6;

import "@openzeppelin/contracts/interfaces/IERC165.sol";

/**
 * on-chain registrar for all registered relayManagers.
 * client can use it instead of events to find relay registration info.
 * NOTE: client should IGNORE the order of these requests.
 */
interface IRelayRegistrar is IERC165 {

    struct RelayInfo {
        //last registration block number
        uint256 lastBlockNumber;
        //stake (first registration) block number
        uint256 stakeBlockNumber;
        address relayManager;
        uint256 baseRelayFee;
        uint256 pctRelayFee;
        string url;
    }

    /// Emitted when a relay server registers or updates its details
    /// Looking at these events lets a client discover relay servers
    event RelayServerRegistered(
        address indexed relayManager,
        uint256 baseRelayFee,
        uint256 pctRelayFee,
        string relayUrl
    );

    /**
     * called by relay server to register (or re-register) itself.
     * The relayer must be staked in the RelayHub
     */
    function registerRelayServer(uint256 baseRelayFee, uint256 pctRelayFee, string calldata url) external;

    /**
     * @return the block number in which the contract has been deployed.
     */
    function getCreationBlock() external view returns (uint256);

    /**
     * does this registrar save state into storage?
     * @return false only events are used for registration
     *  true keep registry in storage, in addition to events
     */
    function isUsingStorageRegistry() external returns (bool);

    function getRelayInfo(address relayManager) external view returns (RelayInfo memory info);

    function readRelayInfos(uint256 oldestBlock, uint256 maxCount) external view returns (RelayInfo[] memory info, uint256 filled);
}
