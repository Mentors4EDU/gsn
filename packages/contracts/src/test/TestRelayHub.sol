// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.0;

import "../RelayHub.sol";

contract TestRelayHub is RelayHub {
    using SafeMath for uint256;

    constructor(
        IStakeManager _stakeManager,
        address _penalizer,
        address _batchGateway,
        RelayHubConfig memory _config
    // solhint-disable-next-line no-empty-blocks
    ) RelayHub(_stakeManager, _penalizer, _batchGateway, _config) {}

    /// Allow depositing for non-paymaster addresses for Gas Calculations tests
    function depositFor(address target) public override payable {
        uint256 amount = msg.value;
        balances[target] = balances[target].add(amount);
        emit Deposited(target, msg.sender, amount);
    }
}
