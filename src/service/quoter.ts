/// <reference path="../common/models.ts" />
/// <reference path="config.ts" />
/// <reference path="utils.ts" />

import Config = require("./config");
import Models = require("../common/models");
import Utils = require("./utils");
import Interfaces = require("./interfaces");

class QuoteOrder {
    constructor(public quote : Models.Quote, public orderId : string) {}
}

// aggregator for quoting
export class Quoter {
    private _bidQuoter : ExchangeQuoter;
    private _askQuoter : ExchangeQuoter;

    constructor(broker : Interfaces.IBroker) {
        this._bidQuoter = new ExchangeQuoter(broker);
        this._askQuoter = new ExchangeQuoter(broker);
    }

    public updateQuote = (q : Models.Quote) : Models.QuoteSent => {
        switch (q.side) {
            case Models.Side.Ask:
                return this._askQuoter.updateQuote(q);
            case Models.Side.Bid:
                return this._bidQuoter.updateQuote(q);
        }
    };
}

// idea: single EQ per side, switch side in Quoter above
// wraps a single broker to make orders behave like quotes
export class ExchangeQuoter {
    private _activeQuote : QuoteOrder = null;
    private _exchange : Models.Exchange;

    constructor(private _broker : Interfaces.IBroker) {
        this._exchange = this._broker.exchange();
        this._broker.OrderUpdate.on(this.handleOrderUpdate);
    }

    public get exchange() {
        return this._broker.exchange();
    }

    private handleOrderUpdate = (o : Models.OrderStatusReport) => {
        switch (o.orderStatus) {
            case Models.OrderStatus.Cancelled:
            case Models.OrderStatus.Complete:
            case Models.OrderStatus.Rejected:
                var bySide = this._activeQuote;
                if (bySide !== null && bySide.orderId === o.orderId) {
                    this._activeQuote = null;
                }
        }
    };

    public updateQuote = (q : Models.Quote) : Models.QuoteSent => {
        if (this._broker.connectStatus !== Models.ConnectivityStatus.Connected)
            return Models.QuoteSent.UnableToSend;

        switch (q.type) {
            case Models.QuoteAction.New:
                if (this._activeQuote !== null) {
                    return this.modify(q);
                }
                else {
                    return this.start(q);
                }
            case Models.QuoteAction.Cancel:
                return this.stop(q);
            default:
                throw new Error("Unknown QuoteAction " + Models.QuoteAction[q.type]);
        }
    };

    private modify = (q : Models.Quote) : Models.QuoteSent => {
        this.stop(q);
        this.start(q);
        return Models.QuoteSent.Modify;
    };

    private start = (q : Models.Quote) : Models.QuoteSent => {
        var existing = this._activeQuote;
        if (existing !== null && existing.quote.equals(q)) {
            return Models.QuoteSent.UnsentDuplicate;
        }

        var newOrder = new Models.SubmitNewOrder(q.side, q.size, Models.OrderType.Limit, q.price, Models.TimeInForce.GTC, this._exchange, q.time);
        var sent = this._broker.sendOrder(newOrder);
        this._activeQuote = new QuoteOrder(q, sent.sentOrderClientId);
        return Models.QuoteSent.First;
    };

    private stop = (q : Models.Quote) : Models.QuoteSent => {
        if (this._activeQuote === null) {
            return Models.QuoteSent.UnsentDuplicate;
        }

        var cxl = new Models.OrderCancel(this._activeQuote.orderId, this._exchange, q.time);
        this._broker.cancelOrder(cxl);
        this._activeQuote = null;
        return Models.QuoteSent.Delete;
    };
}