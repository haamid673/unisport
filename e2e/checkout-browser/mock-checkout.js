// TEST-ONLY stand-in for Razorpay Checkout (window.Razorpay), injected
// by e2e/checkout-browser/vite.config.ts into the local dev server only.
//
// It is NOT Razorpay and contacts nothing. It renders a clearly labelled
// panel and fires exactly the callbacks the production opener
// (services/razorpayCheckout.ts) registers:
//   options.handler({ razorpay_payment_id })        "payment completed"
//   on('payment.failed', cb) with error.metadata    "payment failed"
//   options.modal.ondismiss()                       "window closed"
//   close()                                         closes without a callback
//
// The payment id it reports is typed in by the test operator: it is an id
// the simulator issued (created by the test harness, outside the browser).
// This page never sees the simulator's control token.
(function () {
  'use strict';
  var state = { constructed: 0, opened: [], closedByApp: 0, events: [] };
  window.__mockCheckout = state;

  function strip(options) {
    // record the data the app passed, not its callbacks
    return {
      key: options.key,
      order_id: options.order_id,
      amount: options.amount,
      currency: options.currency,
      name: options.name,
      description: options.description,
      timeout: options.timeout,
      has_handler: typeof options.handler === 'function',
      has_ondismiss: !!(options.modal && typeof options.modal.ondismiss === 'function'),
    };
  }

  function el(tag, attrs, text) {
    var e = document.createElement(tag);
    for (var k in attrs) e.setAttribute(k, attrs[k]);
    if (text) e.textContent = text;
    return e;
  }

  function MockRazorpay(options) {
    if (!(this instanceof MockRazorpay)) throw new Error('use new');
    state.constructed += 1;
    this._options = options;
    this._failed = [];
    this._root = null;
  }

  MockRazorpay.prototype.on = function (event, cb) {
    if (event === 'payment.failed') this._failed.push(cb);
  };

  MockRazorpay.prototype.open = function () {
    var self = this;
    var o = strip(this._options);
    state.opened.push(o);
    var root = el('div', {
      role: 'dialog',
      'aria-label': 'Mock Checkout (test only)',
      'data-mock-checkout': 'open',
      style: 'position:fixed;inset:auto 16px 16px auto;z-index:2147483647;width:340px;background:#fff8e1;' +
        'border:3px dashed #b45309;padding:12px;font:12px/1.4 system-ui,sans-serif;color:#111;box-shadow:0 4px 18px rgba(0,0,0,.25)',
    });
    root.appendChild(el('strong', {}, 'MOCK CHECKOUT — TEST ONLY. Not Razorpay; no provider is contacted.'));
    root.appendChild(el('div', { 'data-mock-field': 'order' }, 'order: ' + o.order_id));
    root.appendChild(el('div', { 'data-mock-field': 'amount' }, 'amount: ' + o.amount + ' (paise) ' + o.currency));
    root.appendChild(el('div', { 'data-mock-field': 'key' }, 'key: ' + o.key));
    var input = el('input', { type: 'text', 'aria-label': 'Simulator payment id', placeholder: 'pay_SIMULATED…', style: 'width:100%;margin:6px 0' });
    root.appendChild(input);
    function id() {
      return input.value.trim();
    }
    var ok = el('button', { type: 'button', 'aria-label': 'Report successful payment' }, 'Report successful payment');
    ok.onclick = function () {
      state.events.push({ type: 'handler', payment_id: id() });
      self._remove();
      self._options.handler({ razorpay_payment_id: id(), razorpay_order_id: o.order_id, razorpay_signature: 'mock-not-a-signature' });
    };
    var fail = el('button', { type: 'button', 'aria-label': 'Report failed payment' }, 'Report failed payment');
    fail.onclick = function () {
      state.events.push({ type: 'payment.failed', payment_id: id() });
      // Razorpay keeps its window open after a failed attempt
      self._failed.forEach(function (cb) {
        cb({ error: { code: 'BAD_REQUEST_ERROR', description: 'mock failure', metadata: { payment_id: id(), order_id: o.order_id } } });
      });
    };
    var dismiss = el('button', { type: 'button', 'aria-label': 'Close checkout' }, 'Close checkout');
    dismiss.onclick = function () {
      state.events.push({ type: 'ondismiss' });
      self._remove();
      if (self._options.modal && self._options.modal.ondismiss) self._options.modal.ondismiss();
    };
    [ok, fail, dismiss].forEach(function (b) {
      b.style.margin = '2px';
      root.appendChild(b);
    });
    this._root = root;
    document.body.appendChild(root);
  };

  MockRazorpay.prototype._remove = function () {
    if (this._root && this._root.parentNode) this._root.parentNode.removeChild(this._root);
    this._root = null;
  };

  // Razorpay documents rzp.close(); the app's watchdog uses it.
  MockRazorpay.prototype.close = function () {
    state.closedByApp += 1;
    state.events.push({ type: 'close()' });
    this._remove();
  };

  window.Razorpay = MockRazorpay;
})();
