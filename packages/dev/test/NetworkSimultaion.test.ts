import { HttpProvider } from 'web3-core'
import { TxOptions } from '@ethereumjs/tx'
import { PrefixedHexString } from 'ethereumjs-util'
import { toBN, toHex } from 'web3-utils'

import { ContractInteractor } from '@opengsn/common/dist/ContractInteractor'
import { GsnTransactionDetails } from '@opengsn/common/dist/types/GsnTransactionDetails'
import { LoggerInterface } from '@opengsn/common/dist/LoggerInterface'
import { NetworkSimulatingProvider } from '@opengsn/common/dist/dev/NetworkSimulatingProvider'
import { ServerTestEnvironment } from './ServerTestEnvironment'
import { SignedTransactionDetails } from '@opengsn/relay/dist/TransactionManager'
import { GSNConfig } from '@opengsn/provider/dist/GSNConfigurator'
import { createClientLogger } from '@opengsn/provider/dist/ClientWinstonLogger'
import { evmMine, evmMineMany, revert, snapshot } from './TestUtils'
import { signedTransactionToHash } from '@opengsn/common/dist/Utils'
import { GSNContractsDeployment } from '@opengsn/common/dist/GSNContractsDeployment'
import { defaultEnvironment } from '@opengsn/common'
import sinon from 'sinon'
import chaiAsPromised from 'chai-as-promised'

const { expect, assert } = require('chai').use(chaiAsPromised)

contract('Network Simulation for Relay Server', function (accounts) {
  const pendingTransactionTimeoutBlocks = 5

  let logger: LoggerInterface
  let env: ServerTestEnvironment
  let provider: NetworkSimulatingProvider

  before(async function () {
    logger = createClientLogger({ logLevel: 'error' })
    provider = new NetworkSimulatingProvider(web3.currentProvider as HttpProvider)
    const maxPageSize = Number.MAX_SAFE_INTEGER
    const contractFactory = async function (deployment: GSNContractsDeployment): Promise<ContractInteractor> {
      const contractInteractor = new ContractInteractor({
        environment: defaultEnvironment,
        maxPageSize,
        provider,
        logger,
        deployment
      })
      await contractInteractor.init()
      return contractInteractor
    }
    env = new ServerTestEnvironment(web3.currentProvider as HttpProvider, accounts)
    const clientConfig: Partial<GSNConfig> = { maxRelayNonceGap: 5 }
    await env.init(clientConfig, {}, contractFactory)
    await env.newServerInstance({ pendingTransactionTimeoutBlocks })
    provider.setDelayTransactions(true)
  })

  describe('without automated mining', function () {
    beforeEach(async function () {
      await env.clearServerStorage()
    })

    it('should resolve once the transaction is broadcast', async function () {
      assert.equal(provider.mempool.size, 0)
      const { txHash } = await env.relayTransaction(false)
      assert.equal(provider.mempool.size, 1)
      const receipt = await env.web3.eth.getTransactionReceipt(txHash)
      assert.isNull(receipt)
      await provider.mineTransaction(txHash)
      assert.equal(provider.mempool.size, 0)
      await env.assertTransactionRelayed(txHash)
    })

    it('should broadcast multiple transactions at once', async function () {
      assert.equal(provider.mempool.size, 0)
      // cannot use the same sender as it will create same request with same forwarder nonce, etc
      const overrideDetails = { from: accounts[1] }
      // noinspection ES6MissingAwait - done on purpose
      const promises = [env.relayTransaction(false), env.relayTransaction(false, overrideDetails)]
      const txs = await Promise.all(promises)
      assert.equal(provider.mempool.size, 2)
      await provider.mineTransaction(txs[0].txHash)
      await env.assertTransactionRelayed(txs[0].txHash)
      await provider.mineTransaction(txs[1].txHash)
      await env.assertTransactionRelayed(txs[1].txHash, overrideDetails)
    })
  })

  describe('boosting stuck pending transactions', function () {
    const gasPriceBelowMarket = toHex(20e9)
    const gasPriceAboveMarket = toHex(30e9)
    const expectedGasPriceAfterBoost = toBN(gasPriceBelowMarket).muln(12).divn(10).toString()
    const stuckTransactionsCount = 5
    const fairlyPricedTransactionIndex = 3
    const originalTxHashes: string[] = []
    const overrideParamsPerTx = new Map<PrefixedHexString, Partial<GsnTransactionDetails>>()

    let rawTxOptions: TxOptions

    before(async function () {
      await env.relayServer.txStoreManager.clearAll()
      await sendMultipleRelayedTransactions(stuckTransactionsCount)
    })

    describe('first time boosting stuck transactions', function () {
      let id: string

      before(async () => {
        id = (await snapshot()).result
      })

      after(async () => {
        await revert(id)
      })

      it('should not boost and resend transactions if not that many blocks passed since it was sent', async function () {
        const latestBlock = await env.web3.eth.getBlock('latest')
        const allBoostedTransactions = await env.relayServer._boostStuckPendingTransactions(latestBlock.number)
        assert.equal(allBoostedTransactions.size, 0)
        const storedTxs = await env.relayServer.txStoreManager.getAll()
        assert.equal(storedTxs.length, stuckTransactionsCount)
        for (let i = 0; i < stuckTransactionsCount; i++) {
          assert.equal(storedTxs[i].txId, originalTxHashes[i])
        }
      })

      it('should boost and resend underpriced transactions if the oldest one does not get mined after being sent for a long time', async function () {
        // Increase time by mining necessary amount of blocks
        await evmMineMany(pendingTransactionTimeoutBlocks)

        const latestBlock = await env.web3.eth.getBlock('latest')
        const allBoostedTransactions = await env.relayServer._boostStuckPendingTransactions(latestBlock.number)

        // NOTE: this is needed for the 'repeated boosting' test
        for (const [originalTxHash, signedTransactionDetails] of allBoostedTransactions) {
          overrideParamsPerTx.set(signedTransactionDetails.transactionHash, overrideParamsPerTx.get(originalTxHash)!)
        }

        // Tx #3 should not be changed
        assert.equal(allBoostedTransactions.size, stuckTransactionsCount - 1)
        await assertGasPrice(allBoostedTransactions, expectedGasPriceAfterBoost)
      })
    })

    describe('repeated boosting', function () {
      const expectedGasPriceAfterSecondBoost = toBN(expectedGasPriceAfterBoost).muln(12).divn(10).toString()

      before('boosting transaction', assertBoostAndRebroadcast)

      it('should not resend the transaction if not enough blocks passed since it was boosted', async function () {
        await evmMineMany(pendingTransactionTimeoutBlocks - 1)
        const latestBlock = await env.web3.eth.getBlock('latest')
        const allBoostedTransactions = await env.relayServer._boostStuckPendingTransactions(latestBlock.number)
        assert.equal(allBoostedTransactions.size, 0)
      })

      it('should boost transactions that are not mined after being boosted another time', async function () {
        await evmMine()
        const latestBlock = await env.web3.eth.getBlock('latest')
        const allBoostedTransactions = await env.relayServer._boostStuckPendingTransactions(latestBlock.number)
        assert.equal(allBoostedTransactions.size, stuckTransactionsCount - 1)
        await assertGasPrice(allBoostedTransactions, expectedGasPriceAfterSecondBoost)
      })
    })

    describe('boosting & rebroadcasting all transactions', function () {
      let id: string
      before(async () => {
        id = (await snapshot()).result
      })
      after(async () => {
        await revert(id)
      })
      it('should boost underpriced transactions and only rebroadcast fairly priced transactions', assertBoostAndRebroadcast)
      it('should throw when trying to boost a transaction with nonce higher than latest on-chain nonce', async function () {
        const storedTxs = await env.relayServer.txStoreManager.getAll()
        const latestNonce = await env.web3.eth.getTransactionCount(storedTxs[0].from)
        assert.equal(storedTxs[0].nonce, latestNonce)
        await env.relayServer.txStoreManager.removeTxsUntilNonce(storedTxs[0].from, latestNonce)
        await evmMineMany(pendingTransactionTimeoutBlocks)
        await expect(env.relayServer._boostStuckPendingTransactions(await env.web3.eth.getBlockNumber())).to.be.eventually.rejectedWith(
          `Boosting: missing nonce ${latestNonce}. Lowest stored tx nonce: ${storedTxs[1].nonce}`)
      })
      it('should not boost any transactions if config.pendingTransactionTimeoutBlocks did not pass yet', async function () {
        await env.relayServer.txStoreManager.clearAll()
        await env.relayServer.transactionManager._initNonces()
        await sendMultipleRelayedTransactions(stuckTransactionsCount)

        const storedTxs = await env.relayServer.txStoreManager.getAll()
        const latestNonce = await env.web3.eth.getTransactionCount(storedTxs[0].from)
        assert.equal(storedTxs[0].nonce, latestNonce)
        const spy = sinon.spy(env.relayServer.logger, 'debug')
        const message = `${storedTxs[0].from} : awaiting transaction with ID: ${storedTxs[0].txId} to be mined. creationBlockNumber: ${storedTxs[0].creationBlockNumber} nonce: ${storedTxs[0].nonce}`
        await env.relayServer._boostStuckPendingTransactions(await env.web3.eth.getBlockNumber())
        sinon.assert.calledWith(spy, message)
        await evmMineMany(pendingTransactionTimeoutBlocks - 1)
        await env.relayServer._boostStuckPendingTransactions(await env.web3.eth.getBlockNumber())
        sinon.assert.calledWith(spy, message)
        sinon.restore()
      })
    })

    async function sendMultipleRelayedTransactions (_stuckTransactionsCount: number): Promise<void> {
      for (let i = 0; i < _stuckTransactionsCount; i++) {
        // Transaction #3 will have a sufficient gas price and shall not be boosted
        // All transaction must come from different senders or else will be rejected on 'nonce mismatch'
        const overrideTxParams: Partial<GsnTransactionDetails> = {
          from: accounts[i],
          maxPriorityFeePerGas: i === fairlyPricedTransactionIndex ? gasPriceAboveMarket : gasPriceBelowMarket,
          maxFeePerGas: i === fairlyPricedTransactionIndex ? gasPriceAboveMarket : gasPriceBelowMarket
        }
        const { signedTx } = await env.relayTransaction(false, overrideTxParams)
        rawTxOptions = env.relayServer.transactionManager.rawTxOptions
        const transactionHash = signedTransactionToHash(signedTx, rawTxOptions)
        originalTxHashes.push(transactionHash)
        overrideParamsPerTx.set(transactionHash, overrideTxParams)
      }
    }

    async function assertGasPrice (signedTransactions: Map<PrefixedHexString, SignedTransactionDetails>, expectedGasPriceAfterBoost: string): Promise<void> {
      let i = 0
      for (const [originalTxHash, signedTransactionDetails] of signedTransactions) {
        if (i === fairlyPricedTransactionIndex) {
          await provider.mineTransaction(originalTxHashes[fairlyPricedTransactionIndex])
        }
        await provider.mineTransaction(signedTransactionDetails.transactionHash)
        const minedTx = await env.web3.eth.getTransaction(signedTransactionDetails.transactionHash)
        const actualTxGasPrice = toBN(minedTx.gasPrice).toString()
        assert.equal(actualTxGasPrice, expectedGasPriceAfterBoost)
        const overrideDetails = overrideParamsPerTx.get(originalTxHash)
        await env.assertTransactionRelayed(signedTransactionDetails.transactionHash, overrideDetails)
        i++
      }
    }

    async function assertBoostAndRebroadcast (): Promise<void> {
      originalTxHashes.length = 0
      await env.relayServer.txStoreManager.clearAll()
      await env.relayServer.transactionManager._initNonces()
      const spy = sinon.spy(env.relayServer.transactionManager, 'resendTransaction')
      await sendMultipleRelayedTransactions(stuckTransactionsCount)
      const storedTxsBefore = await env.relayServer.txStoreManager.getAll()
      await evmMineMany(pendingTransactionTimeoutBlocks)
      const latestBlock = await env.web3.eth.getBlock('latest')
      const allBoostedTransactions = await env.relayServer._boostStuckPendingTransactions(latestBlock.number)
      // NOTE: this is needed for the 'repeated boosting' test
      for (const [originalTxHash, signedTransactionDetails] of allBoostedTransactions) {
        overrideParamsPerTx.set(signedTransactionDetails.transactionHash, overrideParamsPerTx.get(originalTxHash)!)
      }
      assert.equal(allBoostedTransactions.size, stuckTransactionsCount - 1)
      const storedTxsAfter = await env.relayServer.txStoreManager.getAll()
      assert.equal(storedTxsBefore.length, stuckTransactionsCount)
      const spyCalls = spy.getCalls()
      for (let i = 0; i < storedTxsBefore.length; i++) {
        assert.equal(storedTxsBefore[i].attempts + 1, storedTxsAfter[i].attempts)
        if (i === fairlyPricedTransactionIndex) {
          sinon.assert.calledWith(spyCalls[i], storedTxsBefore[i], sinon.match.any, storedTxsBefore[i].maxFeePerGas, storedTxsBefore[i].maxPriorityFeePerGas, sinon.match.any)
        } else {
          sinon.assert.calledWith(spyCalls[i], storedTxsBefore[i], sinon.match.any, parseInt(expectedGasPriceAfterBoost), parseInt(expectedGasPriceAfterBoost), sinon.match.any)
        }
      }
      sinon.restore()
    }
  })
})
