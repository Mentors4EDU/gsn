import { balance, ether, expectEvent, expectRevert } from '@openzeppelin/test-helpers'
import BN from 'bn.js'
import chai from 'chai'

import { decodeRevertReason, getEip712Signature, removeHexPrefix } from '@opengsn/common/dist/Utils'
import { RelayRequest, cloneRelayRequest } from '@opengsn/common/dist/EIP712/RelayRequest'
import { defaultEnvironment } from '@opengsn/common/dist/Environments'
import { TypedRequestData } from '@opengsn/common/dist/EIP712/TypedRequestData'

import {
  RelayHubInstance,
  PenalizerInstance,
  StakeManagerInstance,
  TestRecipientInstance,
  ForwarderInstance,
  TestPaymasterEverythingAcceptedInstance,
  TestPaymasterConfigurableMisbehaviorInstance,
  GatewayForwarderInstance, TestTokenInstance
} from '@opengsn/contracts/types/truffle-contracts'
import { deployHub, encodeRevertReason, revert, snapshot } from './TestUtils'
import { registerForwarderForGsn } from '@opengsn/common/dist/EIP712/ForwarderUtil'

import chaiAsPromised from 'chai-as-promised'
import { RelayRegistrarInstance } from '@opengsn/contracts'
import { constants } from '@opengsn/common'

const { expect, assert } = chai.use(chaiAsPromised)

const RelayHub = artifacts.require('RelayHub')
const StakeManager = artifacts.require('StakeManager')
const Forwarder = artifacts.require('Forwarder')
const Penalizer = artifacts.require('Penalizer')
const GatewayForwarder = artifacts.require('GatewayForwarder')
const TestPaymasterEverythingAccepted = artifacts.require('TestPaymasterEverythingAccepted')
const TestToken = artifacts.require('TestToken')
const TestRecipient = artifacts.require('TestRecipient')
const TestPaymasterStoreContext = artifacts.require('TestPaymasterStoreContext')
const TestPaymasterConfigurableMisbehavior = artifacts.require('TestPaymasterConfigurableMisbehavior')
const RelayRegistrar = artifacts.require('RelayRegistrar')

contract('RelayHub', function ([paymasterOwner, relayOwner, relayManager, relayWorker, senderAddress, other, dest, incorrectWorker]) { // eslint-disable-line no-unused-vars
  const RelayCallStatusCodes = {
    OK: new BN('0'),
    RelayedCallFailed: new BN('1'),
    RejectedByPreRelayed: new BN('2'),
    RejectedByForwarder: new BN('3'),
    RejectedByRecipientRevert: new BN('4'),
    PostRelayedFailed: new BN('5'),
    PaymasterBalanceChanged: new BN('6')
  }

  const chainId = defaultEnvironment.chainId
  const oneEther = ether('1')

  let relayHub: string
  let testToken: TestTokenInstance
  let stakeManager: StakeManagerInstance
  let penalizer: PenalizerInstance
  let relayHubInstance: RelayHubInstance
  let relayRegistrar: RelayRegistrarInstance
  let recipientContract: TestRecipientInstance
  let paymasterContract: TestPaymasterEverythingAcceptedInstance
  let forwarderInstance: ForwarderInstance
  let target: string
  let paymaster: string
  let forwarder: string

  beforeEach(async function () {
    testToken = await TestToken.new()
    stakeManager = await StakeManager.new(defaultEnvironment.maxUnstakeDelay, constants.BURN_ADDRESS)
    penalizer = await Penalizer.new(defaultEnvironment.penalizerConfiguration.penalizeBlockDelay, defaultEnvironment.penalizerConfiguration.penalizeBlockExpiration)
    relayHubInstance = await deployHub(stakeManager.address, penalizer.address, constants.ZERO_ADDRESS, testToken.address, oneEther.toString())
    relayRegistrar = await RelayRegistrar.at(await relayHubInstance.getRelayRegistrar())

    paymasterContract = await TestPaymasterEverythingAccepted.new()
    forwarderInstance = await Forwarder.new()
    forwarder = forwarderInstance.address
    recipientContract = await TestRecipient.new(forwarder)

    // register hub's RelayRequest with forwarder, if not already done.
    await registerForwarderForGsn(forwarderInstance)

    target = recipientContract.address
    paymaster = paymasterContract.address
    relayHub = relayHubInstance.address

    await paymasterContract.setTrustedForwarder(forwarder)
    await paymasterContract.setRelayHub(relayHub)
  })

  it('should retrieve version number', async function () {
    const version = await relayHubInstance.versionHub()
    assert.match(version, /2\.\d*\.\d*-?.*\+opengsn\.hub\.irelayhub/)
  })

  it('should reject setRegistrar for an address that does not implement IPaymaster', async function () {
    await expectRevert(relayHubInstance.setRegistrar(relayHub), 'target is not a valid IRegistrar')
  })

  describe('balances', function () {
    async function testDeposit (sender: string, paymaster: string, amount: BN): Promise<void> {
      const senderBalanceTracker = await balance.tracker(sender)
      const relayHubBalanceTracker = await balance.tracker(relayHub)
      const gasPrice = new BN(1e9)
      const res = await relayHubInstance.depositFor(paymaster, {
        from: sender,
        value: amount,
        gasPrice
      })
      expectEvent.inLogs(res.logs, 'Deposited', {
        paymaster,
        from: sender,
        amount
      })
      const txCost = (new BN(res.receipt.gasUsed)).mul(gasPrice)
      expect(await relayHubInstance.balanceOf(paymaster)).to.be.bignumber.equal(amount)
      expect(await senderBalanceTracker.delta()).to.be.bignumber.equal(amount.neg().sub(txCost))
      expect(await relayHubBalanceTracker.delta()).to.be.bignumber.equal(amount)
    }

    it('can deposit for a valid IPaymaster', async function () {
      await testDeposit(other, paymaster, ether('1'))
    })

    it('can deposit multiple times and have a total deposit larger than the limit', async function () {
      await relayHubInstance.depositFor(paymaster, {
        from: other,
        value: ether('1'),
        gasPrice: 1e9
      })
      await relayHubInstance.depositFor(paymaster, {
        from: other,
        value: ether('1'),
        gasPrice: 1e9
      })
      await relayHubInstance.depositFor(paymaster, {
        from: other,
        value: ether('1'),
        gasPrice: 1e9
      })

      expect(await relayHubInstance.balanceOf(paymaster)).to.be.bignumber.equals(ether('3'))
    })

    it('accounts with deposits can withdraw partially', async function () {
      const amount = ether('1')
      await testDeposit(other, paymaster, amount)

      const { tx } = await paymasterContract.withdrawRelayHubDepositTo(amount.divn(2), dest, { from: paymasterOwner })
      await expectEvent.inTransaction(tx, RelayHub, 'Withdrawn', {
        account: paymaster,
        dest,
        amount: amount.divn(2)
      })
    })

    it('accounts with deposits can withdraw all their balance', async function () {
      const amount = ether('1')
      await testDeposit(other, paymaster, amount)

      const { tx } = await paymasterContract.withdrawRelayHubDepositTo(amount, dest, { from: paymasterOwner })
      await expectEvent.inTransaction(tx, RelayHub, 'Withdrawn', {
        account: paymaster,
        dest,
        amount
      })
    })

    it('accounts cannot withdraw more than their balance', async function () {
      const amount = ether('1')
      await testDeposit(other, paymaster, amount)

      await expectRevert(paymasterContract.withdrawRelayHubDepositTo(amount.addn(1), dest, { from: paymasterOwner }), 'insufficient funds')
    })

    it('should reject depositFor for an address that does not implement IPaymaster', async function () {
      await expectRevert(relayHubInstance.depositFor(target, {
        value: ether('1')
      }), 'target is not a valid IPaymaster')
    })
  })

  describe('relayCall', function () {
    const baseRelayFee = '10000'
    const pctRelayFee = '10'
    const gasPrice = 1e9.toString()
    const maxFeePerGas = 1e9.toString()
    const maxPriorityFeePerGas = 1e9.toString()
    const gasLimit = '1000000'
    const senderNonce = '0'
    let sharedRelayRequestData: RelayRequest
    const paymasterData = '0x'
    const clientId = '1'

    beforeEach(function () {
      sharedRelayRequestData = {
        request: {
          to: target,
          data: '',
          from: senderAddress,
          nonce: senderNonce,
          value: '0',
          gas: gasLimit,
          validUntilTime: '0'
        },
        relayData: {
          pctRelayFee,
          baseRelayFee,
          transactionCalldataGasUsed: 7e6.toString(),
          maxFeePerGas,
          maxPriorityFeePerGas,
          relayWorker,
          forwarder,
          paymaster,
          paymasterData,
          clientId
        }
      }
    })

    context('with unknown worker', function () {
      const signature = '0xdeadbeef'
      const approvalData = '0x'
      const gas = 4e6
      let relayRequest: RelayRequest
      beforeEach(async function () {
        relayRequest = cloneRelayRequest(sharedRelayRequestData)
        relayRequest.request.data = '0xdeadbeef'
        await relayHubInstance.depositFor(paymaster, {
          from: other,
          value: ether('1'),
          gasPrice: 1e9
        })
      })

      it('should not accept a relay call', async function () {
        await expectRevert(
          relayHubInstance.relayCall(10e6, relayRequest, signature, approvalData, {
            from: relayWorker,
            gas
          }),
          'Unknown relay worker')
      })

      context('#setMinimumStakes()', function () {
        it('should assign values correctly with arrays of any size', async function () {
          const tokens = [
            '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
            '0x1f9840a85d5af5bf1d1762f925bdaddc4201f984',
            '0xc944e90c64b2c07662a292be6244bdf05cda44a7',
            '0x6b175474e89094c44da98b954eedeac495271d0f',
            '0xeb4c2781e4eba804ce9a9803c67d0893436bb27d',
            '0x8dae6cb04688c62d939ed9b68d32bc62e49970b1',
            '0xba100000625a3754423978a60c9317c58a424e3d',
            '0x111111111117dc0aa78b770fa6a738034120c302'
          ]
          const minimums = [100, 200, 300, 400, 500, 600, 700, 8000]
          assert.equal(tokens.length, minimums.length)
          await relayHubInstance.setMinimumStakes(tokens, minimums)
          for (let i = 0; i < tokens.length; i++) {
            const min = await relayHubInstance.getMinimumStakePerToken(tokens[i])
            assert.equal(min.toNumber(), minimums[i])
          }
        })

        it('should revert if array lengths do not match', async function () {
          await expectRevert(
            relayHubInstance.setMinimumStakes([relayOwner], [0, 0]),
            'setMinimumStakes: wrong length'
          )
        })
      })

      context('#verifyRelayManagerStaked()', function () {
        let id: string

        async function mintApproveSetOwnerStake (token: TestTokenInstance = testToken, stake: BN = oneEther, unstakeDelay: number = 15000): Promise<void> {
          await token.mint(stake, { from: relayOwner })
          await token.approve(stakeManager.address, stake, { from: relayOwner })
          await stakeManager.setRelayManagerOwner(relayOwner, { from: relayManager })
          await stakeManager.stakeForRelayManager(token.address, relayManager, unstakeDelay, stake, {
            from: relayOwner
          })
        }

        function testRejectsAddRelayWorkers (expectedError: string): void {
          it('should not accept a relay call with error: ' + expectedError, async function () {
            await expectRevert(
              relayHubInstance.addRelayWorkers([relayWorker], {
                from: relayManager
              }),
              expectedError
            )
          })
        }

        afterEach(async function () {
          await revert(id)
        })

        context('with no stake at all', function () {
          testRejectsAddRelayWorkers('relay manager not staked')
        })

        context('with manager stake in forbidden token', function () {
          beforeEach(async function () {
            id = (await snapshot()).result
            const forbiddenToken = await TestToken.new()
            await mintApproveSetOwnerStake(forbiddenToken)
          })
          testRejectsAddRelayWorkers('staking this token is forbidden')
        })

        context('with manager stake that is too small', function () {
          beforeEach(async function () {
            id = (await snapshot()).result
            await mintApproveSetOwnerStake(testToken, ether('0.001'))
            await relayHubInstance.setMinimumStakes([testToken.address], [oneEther])
          })
          testRejectsAddRelayWorkers('stake amount is too small')
        })

        context('with manager stake that unlocks too soon', function () {
          beforeEach(async function () {
            id = (await snapshot()).result
            await mintApproveSetOwnerStake(testToken, ether('1'), 10)
            await relayHubInstance.setMinimumStakes([testToken.address], [oneEther])
          })
          testRejectsAddRelayWorkers('unstake delay is too small')
        })

        context('with manager stake with authorized hub', function () {
          let unauthorizedHub: RelayHubInstance
          beforeEach(async function () {
            id = (await snapshot()).result
            unauthorizedHub = await deployHub(stakeManager.address, penalizer.address, constants.ZERO_ADDRESS, testToken.address, oneEther.toString())
            await mintApproveSetOwnerStake()
            await relayHubInstance.setMinimumStakes([testToken.address], [oneEther])
          })

          it('should not accept a relay call', async function () {
            await expectRevert(
              unauthorizedHub.addRelayWorkers([relayWorker], {
                from: relayManager
              }),
              'this hub is not authorized by SM'
            )
          })
        })

        context('with manager stake unlocked', function () {
          beforeEach(async function () {
            id = (await snapshot()).result
            await mintApproveSetOwnerStake()
            await relayHubInstance.setMinimumStakes([testToken.address], [oneEther])
            await stakeManager.authorizeHubByOwner(relayManager, relayHub, { from: relayOwner })
            await stakeManager.unlockStake(relayManager, { from: relayOwner })
          })
          testRejectsAddRelayWorkers('stake has been withdrawn')
        })
      })
    })

    context('with staked and registered relay', function () {
      const url = 'http://relay.com'
      const message = 'GSN RelayHub'
      const messageWithNoParams = 'Method with no parameters'

      let relayRequest: RelayRequest
      let encodedFunction: string
      let signatureWithPermissivePaymaster: string

      beforeEach(async function () {
        await testToken.mint(ether('2'), { from: relayOwner })
        await testToken.approve(stakeManager.address, ether('2'), { from: relayOwner })
        await stakeManager.setRelayManagerOwner(relayOwner, { from: relayManager })
        await stakeManager.stakeForRelayManager(testToken.address, relayManager, 15000, ether('2'), {
          from: relayOwner
        })
        await stakeManager.authorizeHubByOwner(relayManager, relayHub, { from: relayOwner })

        // truffle-contract doesn't let us create method data from the class, we need an actual instance
        encodedFunction = recipientContract.contract.methods.emitMessage(message).encodeABI()

        await relayHubInstance.addRelayWorkers([relayWorker], { from: relayManager })
        await relayRegistrar.registerRelayServer(baseRelayFee, pctRelayFee, url, { from: relayManager })
        relayRequest = cloneRelayRequest(sharedRelayRequestData)
        relayRequest.request.data = encodedFunction
        const dataToSign = new TypedRequestData(
          chainId,
          forwarder,
          relayRequest
        )
        signatureWithPermissivePaymaster = await getEip712Signature(
          web3,
          dataToSign
        )

        await relayHubInstance.depositFor(paymaster, {
          value: ether('1'),
          from: other
        })
      })

      context('with relay worker that is not externally-owned account', function () {
        it('should not accept relay requests', async function () {
          const signature = '0xdeadbeef'
          const gas = 4e6
          const TestRelayWorkerContract = artifacts.require('TestRelayWorkerContract')
          const testRelayWorkerContract = await TestRelayWorkerContract.new()
          await relayHubInstance.addRelayWorkers([testRelayWorkerContract.address], {
            from: relayManager
          })
          await expectRevert(
            testRelayWorkerContract.relayCall(
              relayHubInstance.address,
              10e6,
              relayRequest,
              signature,
              {
                gas
              }),
            'relay worker must be EOA')
        })
      })
      context('with view functions only', function () {
        let misbehavingPaymaster: TestPaymasterConfigurableMisbehaviorInstance
        let relayRequestMisbehavingPaymaster: RelayRequest

        beforeEach(async function () {
          misbehavingPaymaster = await TestPaymasterConfigurableMisbehavior.new()
          await misbehavingPaymaster.setTrustedForwarder(forwarder)
          await misbehavingPaymaster.setRelayHub(relayHub)
          await relayHubInstance.depositFor(misbehavingPaymaster.address, {
            value: ether('1'),
            from: other
          })
          relayRequestMisbehavingPaymaster = cloneRelayRequest(relayRequest)
          relayRequestMisbehavingPaymaster.relayData.paymaster = misbehavingPaymaster.address
        })

        it('should get \'paymasterAccepted = true\' and no revert reason as view call result of \'relayCall\' for a valid transaction', async function () {
          const relayCallView = await relayHubInstance.contract.methods.relayCall(
            10e6,
            relayRequest,
            signatureWithPermissivePaymaster, '0x')
            .call({
              from: relayWorker,
              gas: 7e6,
              gasPrice: 1e9
            })
          assert.equal(relayCallView.returnValue, null)
          assert.equal(relayCallView.paymasterAccepted, true)
        })

        it('should get Paymaster\'s reject reason from view call result of \'relayCall\' for a transaction with a wrong signature', async function () {
          await misbehavingPaymaster.setReturnInvalidErrorCode(true)
          const relayCallView =
            await relayHubInstance.contract.methods
              .relayCall(10e6, relayRequestMisbehavingPaymaster, '0x00', '0x')
              .call({ from: relayWorker, gas: 7e6, gasPrice: 1e9 })

          assert.equal(relayCallView.paymasterAccepted, false)

          assert.equal(relayCallView.returnValue, encodeRevertReason('invalid code'))
          assert.equal(decodeRevertReason(relayCallView.returnValue), 'invalid code')
        })
      })

      context('with funded paymaster', function () {
        let signature

        let paymasterWithContext
        let misbehavingPaymaster: TestPaymasterConfigurableMisbehaviorInstance

        let relayRequestPaymasterWithContext: RelayRequest
        let signatureWithContextPaymaster: string

        let signatureWithMisbehavingPaymaster: string
        let relayRequestMisbehavingPaymaster: RelayRequest
        const gas = 4e6

        beforeEach(async function () {
          paymasterWithContext = await TestPaymasterStoreContext.new()
          misbehavingPaymaster = await TestPaymasterConfigurableMisbehavior.new()
          await paymasterWithContext.setTrustedForwarder(forwarder)
          await misbehavingPaymaster.setTrustedForwarder(forwarder)
          await paymasterWithContext.setRelayHub(relayHub)
          await misbehavingPaymaster.setRelayHub(relayHub)
          await relayHubInstance.depositFor(paymasterWithContext.address, {
            value: ether('1'),
            from: other
          })
          await relayHubInstance.depositFor(misbehavingPaymaster.address, {
            value: ether('1'),
            from: other
          })
          let dataToSign = new TypedRequestData(
            chainId,
            forwarder,
            relayRequest
          )

          signature = await getEip712Signature(
            web3,
            dataToSign
          )

          relayRequestMisbehavingPaymaster = cloneRelayRequest(relayRequest)
          relayRequestMisbehavingPaymaster.relayData.paymaster = misbehavingPaymaster.address

          dataToSign = new TypedRequestData(
            chainId,
            forwarder,
            relayRequestMisbehavingPaymaster
          )
          signatureWithMisbehavingPaymaster = await getEip712Signature(
            web3,
            dataToSign
          )

          relayRequestPaymasterWithContext = cloneRelayRequest(relayRequest)
          relayRequestPaymasterWithContext.relayData.paymaster = paymasterWithContext.address
          dataToSign = new TypedRequestData(
            chainId,
            forwarder,
            relayRequestPaymasterWithContext
          )
          signatureWithContextPaymaster = await getEip712Signature(
            web3,
            dataToSign
          )
        })

        it('should revert if encoded function contains extra bytes', async () => {
          const encoded = await relayHubInstance.contract.methods.relayCall(10e6, relayRequest, signatureWithPermissivePaymaster, '0x').encodeABI() as string
          await expectRevert(web3.eth.call({
            data: encoded + '1234',
            from: relayWorker,
            to: relayHubInstance.address,
            gas,
            gasPrice
          }), 'Error: VM Exception while processing transaction: reverted with reason string \'extra msg.data bytes\'')
        })

        it('relayCall executes the transaction and increments sender nonce on hub', async function () {
          const nonceBefore = await forwarderInstance.getNonce(senderAddress)

          const {
            tx,
            logs
          } = await relayHubInstance.relayCall(10e6, relayRequest, signatureWithPermissivePaymaster, '0x', {
            from: relayWorker,
            gas,
            gasPrice
          })
          const nonceAfter = await forwarderInstance.getNonce(senderAddress)
          assert.equal(nonceBefore.addn(1).toNumber(), nonceAfter.toNumber())

          await expectEvent.inTransaction(tx, TestRecipient, 'SampleRecipientEmitted', {
            message,
            realSender: senderAddress,
            msgSender: forwarder,
            origin: relayWorker
          })

          const expectedReturnValue = web3.eth.abi.encodeParameter('string', 'emitMessage return value')
          expectEvent.inLogs(logs, 'TransactionResult', {
            status: RelayCallStatusCodes.OK,
            returnValue: expectedReturnValue
          })
          expectEvent.inLogs(logs, 'TransactionRelayed', {
            status: RelayCallStatusCodes.OK
          })
        })

        it('relayCall executes type 2 transaction and increments sender nonce on hub', async function () {
          const nonceBefore = await forwarderInstance.getNonce(senderAddress)
          const eip1559relayRequest = cloneRelayRequest(relayRequest)
          eip1559relayRequest.relayData.maxFeePerGas = 1e12.toString()
          eip1559relayRequest.relayData.maxPriorityFeePerGas = 1e9.toString()
          const gasPrice = 1e10.toString()
          const dataToSign = new TypedRequestData(
            chainId,
            eip1559relayRequest.relayData.forwarder,
            eip1559relayRequest
          )
          const signature = await getEip712Signature(
            web3,
            dataToSign
          )
          const {
            tx,
            logs
          } = await relayHubInstance.relayCall(10e6, eip1559relayRequest, signature, '0x', {
            from: relayWorker,
            gas,
            gasPrice
          })
          const nonceAfter = await forwarderInstance.getNonce(senderAddress)
          assert.equal(nonceBefore.addn(1).toNumber(), nonceAfter.toNumber())

          await expectEvent.inTransaction(tx, TestRecipient, 'SampleRecipientEmitted', {
            message,
            realSender: senderAddress,
            msgSender: forwarder,
            origin: relayWorker
          })

          const expectedReturnValue = web3.eth.abi.encodeParameter('string', 'emitMessage return value')
          expectEvent.inLogs(logs, 'TransactionResult', {
            status: RelayCallStatusCodes.OK,
            returnValue: expectedReturnValue
          })
          expectEvent.inLogs(logs, 'TransactionRelayed', {
            status: RelayCallStatusCodes.OK
          })
        })

        it('relayCall should refuse to re-send transaction with same nonce', async function () {
          const { tx } = await relayHubInstance.relayCall(10e6, relayRequest, signatureWithPermissivePaymaster, '0x', {
            from: relayWorker,
            gas,
            gasPrice
          })
          await expectEvent.inTransaction(tx, TestRecipient, 'SampleRecipientEmitted')

          const ret = await relayHubInstance.relayCall(10e6, relayRequest, signatureWithPermissivePaymaster, '0x', {
            from: relayWorker,
            gas,
            gasPrice
          })

          await expectEvent(ret, 'TransactionRejectedByPaymaster', { reason: encodeRevertReason('FWD: nonce mismatch') })
        })
        // This test is added due to a regression that almost slipped to production.
        it('relayCall executes the transaction with no parameters', async function () {
          const encodedFunction = recipientContract.contract.methods.emitMessageNoParams().encodeABI()
          const relayRequestNoCallData = cloneRelayRequest(relayRequest)
          relayRequestNoCallData.request.data = encodedFunction
          const dataToSign = new TypedRequestData(
            chainId,
            forwarder,
            relayRequestNoCallData
          )
          signature = await getEip712Signature(
            web3,
            dataToSign
          )
          const { tx } = await relayHubInstance.relayCall(10e6, relayRequestNoCallData, signature, '0x', {
            from: relayWorker,
            gas,
            gasPrice
          })
          await expectEvent.inTransaction(tx, TestRecipient, 'SampleRecipientEmitted', {
            message: messageWithNoParams,
            realSender: senderAddress,
            msgSender: forwarder,
            origin: relayWorker
          })
        })

        it('relayCall executes a transaction even if recipient call reverts', async function () {
          const encodedFunction = recipientContract.contract.methods.testRevert().encodeABI()
          const relayRequestRevert = cloneRelayRequest(relayRequest)
          relayRequestRevert.request.data = encodedFunction
          const dataToSign = new TypedRequestData(
            chainId,
            forwarder,
            relayRequestRevert
          )
          signature = await getEip712Signature(
            web3,
            dataToSign
          )
          const { logs } = await relayHubInstance.relayCall(10e6, relayRequestRevert, signature, '0x', {
            from: relayWorker,
            gas,
            gasPrice
          })

          const expectedReturnValue = '0x08c379a0' + removeHexPrefix(web3.eth.abi.encodeParameter('string', 'always fail'))
          expectEvent.inLogs(logs, 'TransactionResult', {
            status: RelayCallStatusCodes.RelayedCallFailed,
            returnValue: expectedReturnValue
          })
          expectEvent.inLogs(logs, 'TransactionRelayed', {
            status: RelayCallStatusCodes.RelayedCallFailed
          })
        })

        it('postRelayedCall receives values returned in preRelayedCall', async function () {
          const { tx } = await relayHubInstance.relayCall(10e6, relayRequestPaymasterWithContext,
            signatureWithContextPaymaster, '0x', {
              from: relayWorker,
              gas,
              gasPrice
            })

          await expectEvent.inTransaction(tx, TestPaymasterStoreContext, 'SampleRecipientPostCallWithValues', {
            context: 'context passed from preRelayedCall to postRelayedCall'
          })
        })

        it('relaying is aborted if the paymaster reverts the preRelayedCall', async function () {
          await misbehavingPaymaster.setReturnInvalidErrorCode(true)
          const { logs } = await relayHubInstance.relayCall(10e6, relayRequestMisbehavingPaymaster,
            signatureWithMisbehavingPaymaster, '0x', {
              from: relayWorker,
              gas,
              gasPrice
            })

          expectEvent.inLogs(logs, 'TransactionRejectedByPaymaster', { reason: encodeRevertReason('invalid code') })
        })

        it('should revert with out-of-gas if gas limit is too low for a relayed transaction', async function () {
          const gas = '200000' // not enough for a 'relayCall' transaction
          await expectRevert(
            relayHubInstance.relayCall(10e6, relayRequestMisbehavingPaymaster, signatureWithMisbehavingPaymaster, '0x', {
              from: relayWorker,
              gasPrice,
              gas: gas
            }),
            'revert')
        })

        it('should not accept relay requests with incorrect relay worker', async function () {
          await relayHubInstance.addRelayWorkers([incorrectWorker], { from: relayManager })
          await expectRevert(
            relayHubInstance.relayCall(10e6, relayRequestMisbehavingPaymaster, signatureWithMisbehavingPaymaster, '0x', {
              from: incorrectWorker,
              gasPrice,
              gas
            }),
            'Not a right worker')
        })

        it('should not accept relay requests if destination recipient doesn\'t have a balance to pay for it',
          async function () {
            const paymaster2 = await TestPaymasterEverythingAccepted.new()
            await paymaster2.setTrustedForwarder(forwarder)
            await paymaster2.setRelayHub(relayHub)
            const maxPossibleCharge = (await relayHubInstance.calculateCharge(gasLimit, {
              maxFeePerGas,
              maxPriorityFeePerGas,
              pctRelayFee,
              baseRelayFee,
              transactionCalldataGasUsed: 7e6.toString(),
              relayWorker,
              forwarder,
              paymaster: paymaster2.address,
              paymasterData: '0x',
              clientId: '1'
            })).toNumber()
            await paymaster2.deposit({ value: (maxPossibleCharge - 1).toString() }) // TODO: replace with correct margin calculation

            const relayRequestPaymaster2 = cloneRelayRequest(relayRequest)
            relayRequestPaymaster2.relayData.paymaster = paymaster2.address

            await expectRevert(
              relayHubInstance.relayCall(10e6, relayRequestPaymaster2, signatureWithMisbehavingPaymaster, '0x', {
                from: relayWorker,
                gas,
                gasPrice
              }),
              'Paymaster balance too low')
          })

        it('should not execute the \'relayedCall\' if \'preRelayedCall\' reverts', async function () {
          await misbehavingPaymaster.setRevertPreRelayCall(true)
          // @ts-ignore (there is a problem with web3 types annotations that must be solved)
          const startBlock = await web3.eth.getBlockNumber()

          const { logs } = await relayHubInstance.relayCall(10e6, relayRequestMisbehavingPaymaster,
            signatureWithMisbehavingPaymaster, '0x', {
              from: relayWorker,
              gas,
              gasPrice: gasPrice
            })

          // There should not be an event emitted, which means the result of 'relayCall' was indeed reverted
          const logsMessages = await recipientContract.contract.getPastEvents('SampleRecipientEmitted', {
            fromBlock: startBlock,
            toBlock: 'latest'
          })
          assert.equal(0, logsMessages.length)
          // const expectedReturnValue = '0x08c379a0' + removeHexPrefix(web3.eth.abi.encodeParameter('string', 'You asked me to revert, remember?'))
          expectEvent.inLogs(logs, 'TransactionRejectedByPaymaster', {
            reason: encodeRevertReason('You asked me to revert, remember?')
          })
        })

        it('should fail a transaction if paymaster.getGasAndDataLimits is too expensive', async function () {
          await misbehavingPaymaster.setExpensiveGasLimits(true)

          await expectRevert(relayHubInstance.relayCall(10e6, relayRequestMisbehavingPaymaster,
            signatureWithMisbehavingPaymaster, '0x', {
              from: relayWorker,
              gas,
              gasPrice: gasPrice
            }), 'revert')
        })

        it('should revert the \'relayedCall\' if \'postRelayedCall\' reverts', async function () {
          await misbehavingPaymaster.setRevertPostRelayCall(true)
          const { logs } = await relayHubInstance.relayCall(10e6, relayRequestMisbehavingPaymaster,
            signatureWithMisbehavingPaymaster, '0x', {
              from: relayWorker,
              gas,
              gasPrice: gasPrice
            })

          // @ts-ignore (there is a problem with web3 types annotations that must be solved)
          const startBlock = await web3.eth.getBlockNumber()
          // There should not be an event emitted, which means the result of 'relayCall' was indeed reverted
          const logsMessages = await recipientContract.contract.getPastEvents('SampleRecipientEmitted', {
            fromBlock: startBlock,
            toBlock: 'latest'
          })
          assert.equal(0, logsMessages.length)
          expectEvent.inLogs(logs, 'TransactionRelayed', { status: RelayCallStatusCodes.PostRelayedFailed })
        })

        describe('recipient balance withdrawal ban', function () {
          let misbehavingPaymaster: TestPaymasterConfigurableMisbehaviorInstance
          let relayRequestMisbehavingPaymaster: RelayRequest
          let signature: string
          beforeEach(async function () {
            misbehavingPaymaster = await TestPaymasterConfigurableMisbehavior.new()
            await misbehavingPaymaster.setTrustedForwarder(forwarder)
            await misbehavingPaymaster.setRelayHub(relayHub)
            await relayHubInstance.depositFor(misbehavingPaymaster.address, {
              value: ether('1'),
              from: other
            })

            relayRequestMisbehavingPaymaster = cloneRelayRequest(relayRequest)
            relayRequestMisbehavingPaymaster.relayData.paymaster = misbehavingPaymaster.address
            const dataToSign = new TypedRequestData(
              chainId,
              forwarder,
              relayRequestMisbehavingPaymaster
            )
            signature = await getEip712Signature(
              web3,
              dataToSign
            )
          })

          it('reverts relayed call if recipient withdraws balance during preRelayedCall', async function () {
            await misbehavingPaymaster.setWithdrawDuringPreRelayedCall(true)
            await assertRevertWithPaymasterBalanceChanged()
          })

          it('reverts relayed call if recipient withdraws balance during the relayed call', async function () {
            await recipientContract.setWithdrawDuringRelayedCall(misbehavingPaymaster.address)
            await assertRevertWithPaymasterBalanceChanged()
          })

          it('reverts relayed call if recipient withdraws balance during postRelayedCall', async function () {
            await misbehavingPaymaster.setWithdrawDuringPostRelayedCall(true)
            await assertRevertWithPaymasterBalanceChanged()
          })

          async function assertRevertWithPaymasterBalanceChanged (): Promise<void> {
            const { logs } = await relayHubInstance.relayCall(10e6, relayRequestMisbehavingPaymaster, signature, '0x', {
              from: relayWorker,
              gas,
              gasPrice
            })
            expectEvent.inLogs(logs, 'TransactionRelayed', { status: RelayCallStatusCodes.PaymasterBalanceChanged })
          }
        })
        context('with BatchGateway configured', function () {
          const batchGateway = other

          let gatewayForwarder: GatewayForwarderInstance
          let relayHubInstance: RelayHubInstance
          let recipientContract: TestRecipientInstance
          let relayRequest: RelayRequest

          before(async function () {
            relayRequest = cloneRelayRequest(sharedRelayRequestData)
            gatewayForwarder = await GatewayForwarder.new()
            await registerForwarderForGsn(gatewayForwarder)
            relayHubInstance = await deployHub(stakeManager.address, penalizer.address, batchGateway, testToken.address, oneEther.toString())
            recipientContract = await TestRecipient.new(gatewayForwarder.address)
            await gatewayForwarder.setTrustedRelayHub(relayHubInstance.address)
            await paymasterContract.setTrustedForwarder(gatewayForwarder.address)
            await paymasterContract.setRelayHub(relayHubInstance.address)
            await relayHubInstance.depositFor(paymasterContract.address, {
              from: senderAddress,
              value: ether('1')
            })

            // register relay manager and worker
            await stakeManager.authorizeHubByOwner(relayManager, relayHubInstance.address, { from: relayOwner })
            await relayHubInstance.addRelayWorkers([relayWorker], {
              from: relayManager
            })

            relayRequest.request.to = recipientContract.address
            relayRequest.request.data = recipientContract.contract.methods.emitMessageNoParams().encodeABI()
            relayRequest.relayData.paymaster = paymasterContract.address
            relayRequest.relayData.forwarder = gatewayForwarder.address
          })

          it('should reject relayCall with incorrect non-empty signature coming from the BatchGateway', async function () {
            const {
              logs
            } = await relayHubInstance.relayCall(10e6, relayRequest, '0xdeadbeef', '0x', {
              from: batchGateway,
              gas
            })
            // @ts-ignore
            const reasonHex: string = logs[1].args?.reason as string
            const rejectReason = decodeRevertReason(reasonHex)
            assert.equal(rejectReason, 'ECDSA: invalid signature length')
          })

          it('should relay relayCall with correct non-empty signature coming from the BatchGateway', async function () {
            const dataToSign = new TypedRequestData(
              chainId,
              gatewayForwarder.address,
              relayRequest
            )
            signatureWithPermissivePaymaster = await getEip712Signature(
              web3,
              dataToSign
            )
            const {
              tx
            } = await relayHubInstance.relayCall(10e6, relayRequest, signatureWithPermissivePaymaster, '0x', {
              from: batchGateway,
              gas
            })
            await expectEvent.inTransaction(tx, TestRecipient, 'SampleRecipientEmitted', {
              message: 'Method with no parameters'
            })
          })

          it('should reject relayCall with empty signature coming from a valid worker', async function () {
            await expectRevert(
              relayHubInstance.relayCall(10e6, relayRequest, '0x', '0x', {
                from: relayWorker,
                gas
              }),
              'missing signature or bad gateway')
          })

          it('should reject relayCall that reimburses an invalid worker', async function () {
            const relayRequestWithInvalidWorker = cloneRelayRequest(relayRequest)
            relayRequestWithInvalidWorker.relayData.relayWorker = incorrectWorker
            await expectRevert(
              relayHubInstance.relayCall(10e6, relayRequestWithInvalidWorker, signatureWithPermissivePaymaster, '0x', {
                from: batchGateway,
                gas
              }),
              'Unknown relay worker')
          })

          it('should accept relayCall with empty signature coming from the BatchGateway', async function () {
            const relayRequestWithNonce = cloneRelayRequest(relayRequest)
            relayRequestWithNonce.request.nonce = (await gatewayForwarder.getNonce(relayRequest.request.from)).toString()
            const dataToSign = new TypedRequestData(
              chainId,
              gatewayForwarder.address,
              relayRequestWithNonce
            )
            signatureWithPermissivePaymaster = await getEip712Signature(
              web3,
              dataToSign
            )
            const {
              tx
            } = await relayHubInstance.relayCall(10e6, relayRequestWithNonce, '0x', '0x', {
              from: batchGateway,
              gas
            })
            await expectEvent.inTransaction(tx, TestRecipient, 'SampleRecipientEmitted', {
              message: 'Method with no parameters',
              realSender: senderAddress,
              msgSender: gatewayForwarder.address,
              origin: batchGateway
            })
          })
        })
      })
    })
  })
})
