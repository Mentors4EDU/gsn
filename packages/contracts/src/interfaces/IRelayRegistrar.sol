//SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.6;

/**
 * on-chain registrar for all registered relayManagers.
 * client can use it instead of events to find relay registration info.
 * NOTE: client should IGNORE the order of these requests.
 */
interface IRelayRegistrar {

    struct RelayInfo {
        uint blockNumber;
        address relayManager;
        uint baseRelayFee;
        uint pctRelayFee;
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
     * @param prevItem - output of getPrev(relayServerAddress). Can be left as zero, but might require more on-chain calculation
     */
    function registerRelayServer(address prevItem, uint256 baseRelayFee, uint256 pctRelayFee, string calldata url) external;

    /**
     * does this registrar save state into storage?
     * @return false only events are used for registration
     *  true keep registry in storage, in addition to events
     */
    function isUsingStorageRegistry() external returns (bool);

    function getRelayInfo(address relayManager) external view returns (RelayInfo memory info);

    function readRelayInfos(uint oldestBlock, uint maxCount) external view returns (RelayInfo[] memory info, uint filled);

    function readRelayInfosFrom(address from, uint oldestBlock, uint maxCount) external view returns (RelayInfo[] memory ret, uint filled, address nextFrom);
}