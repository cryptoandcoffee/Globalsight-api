'use strict';

var imports = require('soop').imports();
var _ = require('lodash');
var async = require('async');
var Globaltokencore = require('Globaltokencore');
var GlobaltokencoreAddress = Globaltokencore.Address;
var GlobaltokencoreTransaction = Globaltokencore.Transaction;
var GlobaltokencoreUtil = Globaltokencore.util;
var Parser = Globaltokencore.BinaryParser;
var Buffer = Globaltokencore.Buffer;
var TransactionDb = imports.TransactionDb || require('../../lib/TransactionDb').default();
var BlockDb = imports.BlockDb || require('../../lib/BlockDb').default();
var config = require('../../config/config');
var CONCURRENCY = 5;

function Address(addrStr) {
  this.balanceSat = 0;
  this.totalReceivedSat = 0;
  this.totalSentSat = 0;

  this.unconfirmedBalanceSat = 0;

  this.txApperances = 0;
  this.unconfirmedTxApperances = 0;
  this.seen = {};

  // TODO store only txids? +index? +all?
  this.transactions = [];
  this.unspent = [];

  var convertInput = new GlobaltokencoreAddress(addrStr);
  var convertOutput = GlobaltokencoreAddress.fromScriptPubKey(convertInput.getScriptPubKey());
  GlobaltokencoreAddress.validate(convertOutput);
  var a = new GlobaltokencoreAddress(convertOutput.toString());
  a.validate(); // should be okay, but just in case.
  this.addrStr = a.toString();

  Object.defineProperty(this, 'totalSent', {
    get: function() {
      return parseFloat(this.totalSentSat) / parseFloat(GlobaltokencoreUtil.COIN);
    },
    set: function(i) {
      this.totalSentSat = i * GlobaltokencoreUtil.COIN;
    },
    enumerable: 1,
  });

  Object.defineProperty(this, 'balance', {
    get: function() {
      return parseFloat(this.balanceSat) / parseFloat(GlobaltokencoreUtil.COIN);
    },
    set: function(i) {
      this.balance = i * GlobaltokencoreUtil.COIN;
    },
    enumerable: 1,
  });

  Object.defineProperty(this, 'totalReceived', {
    get: function() {
      return parseFloat(this.totalReceivedSat) / parseFloat(GlobaltokencoreUtil.COIN);
    },
    set: function(i) {
      this.totalReceived = i * GlobaltokencoreUtil.COIN;
    },
    enumerable: 1,
  });


  Object.defineProperty(this, 'unconfirmedBalance', {
    get: function() {
      return parseFloat(this.unconfirmedBalanceSat) / parseFloat(GlobaltokencoreUtil.COIN);
    },
    set: function(i) {
      this.unconfirmedBalanceSat = i * GlobaltokencoreUtil.COIN;
    },
    enumerable: 1,
  });

}

Address.prototype.getObj = function() {
  // Normalize json address
  return {
    'addrStr': this.addrStr,
    'balance': this.balance,
    'balanceSat': this.balanceSat,
    'totalReceived': this.totalReceived,
    'totalReceivedSat': this.totalReceivedSat,
    'totalSent': this.totalSent,
    'totalSentSat': this.totalSentSat,
    'unconfirmedBalance': this.unconfirmedBalance,
    'unconfirmedBalanceSat': this.unconfirmedBalanceSat,
    'unconfirmedTxApperances': this.unconfirmedTxApperances,
    'txApperances': this.txApperances,
    'transactions': this.transactions
  };
};

Address.prototype._addTxItem = function(txItem, txList, includeInfo) {
  function addTx(data) {
    if (!txList) return;
    if (includeInfo) {
      txList.push(data);
    } else {
      txList.push(data.txid);
    }
  };

  var add = 0,
    addSpend = 0;
  var v = txItem.value_sat;
  var seen = this.seen;

  // Founding tx
  if (!seen[txItem.txid]) {
    seen[txItem.txid] = 1;
    add = 1;

    addTx({
      txid: txItem.txid,
      ts: txItem.ts,
      firstSeenTs: txItem.firstSeenTs,
    });
  }

  // Spent tx
  if (txItem.spentTxId && !seen[txItem.spentTxId]) {
    addTx({
      txid: txItem.spentTxId,
      ts: txItem.spentTs
    });
    seen[txItem.spentTxId] = 1;
    addSpend = 1;
  }
  if (txItem.isConfirmed) {
    this.txApperances += add;
    this.totalReceivedSat += v;
    if (!txItem.spentTxId) {
      //unspent
      this.balanceSat += v;
    } else if (!txItem.spentIsConfirmed) {
      // unspent
      this.balanceSat += v;
      this.unconfirmedBalanceSat -= v;
      this.unconfirmedTxApperances += addSpend;
    } else {
      // spent
      this.totalSentSat += v;
      this.txApperances += addSpend;
    }
  } else {
    this.unconfirmedBalanceSat += v;
    this.unconfirmedTxApperances += add;
  }
};

// opts are
// .onlyUnspent
// .txLimit     (=0 -> no txs, => -1 no limit)
// .includeTxInfo
// 
Address.prototype.update = function(next, opts) {
  var self = this;
  if (!self.addrStr) return next();
  opts = opts || {};

  if (!('ignoreCache' in opts))
    opts.ignoreCache = config.ignoreCache;

  // should collect txList from address?
  var txList = opts.txLimit === 0 ? null : [];

  var tDb = TransactionDb;
  var bDb = BlockDb;
  tDb.fromAddr(self.addrStr, opts, function(err, txOut) {
    if (err) return next(err);

    bDb.fillConfirmations(txOut, function(err) {
      if (err) return next(err);

      tDb.cacheConfirmations(txOut, function(err) {
        // console.log('[Address.js.161:txOut:]',txOut); //TODO
        if (err) return next(err);
        if (opts.onlyUnspent) {
          txOut = txOut.filter(function(x) {
            return !x.spentTxId;
          });
          tDb.fillScriptPubKey(txOut, function() {
            //_.filter will filterout unspend without scriptPubkey
            //(probably from double spends)
            self.unspent = _.filter(txOut.map(function(x) {
              return {
                address: self.addrStr,
                txid: x.txid,
                vout: x.index,
                ts: x.ts,
                scriptPubKey: x.scriptPubKey,
                amount: x.value_sat / GlobaltokencoreUtil.COIN,
                confirmations: x.isConfirmedCached ? (config.safeConfirmations) : x.confirmations,
                confirmationsFromCache: !!x.isConfirmedCached,
              };
            }), 'scriptPubKey');;
            return next();
          });
        } else {
          txOut.forEach(function(txItem) {
            self._addTxItem(txItem, txList, opts.includeTxInfo);
          });
          if (txList)
            self.transactions = txList;
          return next();
        }
      });
    });
  });
};

module.exports = require('soop')(Address);
