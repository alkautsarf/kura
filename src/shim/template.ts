// Userscript injected into qutebrowser. Placeholders __KURA_HOST__,
// __KURA_PORT__, __KURA_SECRET__ are replaced by install.ts before write.

export const USERSCRIPT_TEMPLATE = `// ==UserScript==
// @name         kura
// @namespace    kura
// @version      0.1
// @description  inject window.ethereum routed to local kura daemon
// @match        *://*/*
// @run-at       document-start
// @grant        GM.xmlHttpRequest
// @grant        GM_xmlhttpRequest
// @connect      127.0.0.1
// ==/UserScript==

(function () {
  if (window.__kura_injected) return;
  window.__kura_injected = true;

  var HOST = "__KURA_HOST__";
  var PORT = __KURA_PORT__;
  var SECRET = "__KURA_SECRET__";
  var ORIGIN = location.origin;
  var BASE = "https://" + HOST + ":" + PORT;

  var gm = (typeof GM !== "undefined" && GM.xmlHttpRequest) ? GM.xmlHttpRequest : (typeof GM_xmlhttpRequest !== "undefined" ? GM_xmlhttpRequest : null);

  // 3 attempts total with 200ms backoff. Only retry on transport failure
  // (status=0 = ECONNREFUSED / connection never reached daemon, e.g., briefly
  // mid brew-upgrade or launchctl-kickstart). Non-zero status means the daemon
  // received the request and responded; retrying would risk creating duplicate
  // /requests entries (two popups for one user click).
  function req(path, body) {
    return new Promise(function (resolve, reject) {
      var attemptsLeft = 3;
      function attempt() {
        attemptsLeft -= 1;
        if (!gm) {
          fetch(BASE + path, {
            method: body ? "POST" : "GET",
            headers: { "X-Kura-Key": SECRET, "Content-Type": "application/json" },
            body: body ? JSON.stringify(body) : undefined,
          }).then(function (r) { return r.json(); }).then(resolve, function (e) {
            if (attemptsLeft > 0) { setTimeout(attempt, 200); return; }
            reject(e);
          });
          return;
        }
        gm({
          method: body ? "POST" : "GET",
          url: BASE + path,
          headers: { "X-Kura-Key": SECRET, "Content-Type": "application/json" },
          data: body ? JSON.stringify(body) : undefined,
          onload: function (r) {
            try { resolve(JSON.parse(r.responseText)); } catch (e) { reject(new Error("kura: bad json: " + (r.responseText||"").slice(0,80))); }
          },
          onerror: function (e) {
            var status = e && e.status;
            if (attemptsLeft > 0 && (!status || status === 0)) {
              console.warn("kura: transport failure (status=" + status + "), retrying in 200ms (" + attemptsLeft + " left)");
              setTimeout(attempt, 200);
              return;
            }
            var info = "kura GM.xhr error: status=" + status + " statusText=" + (e && e.statusText) + " readyState=" + (e && e.readyState);
            console.error(info, e);
            reject(new Error(info));
          },
          ontimeout: function () {
            if (attemptsLeft > 0) {
              console.warn("kura: GM.xhr timeout, retrying in 200ms (" + attemptsLeft + " left)");
              setTimeout(attempt, 200);
              return;
            }
            reject(new Error("kura GM.xhr timeout"));
          },
        });
      }
      attempt();
    });
  }

  var listeners = {};
  function emit(name, payload) {
    (listeners[name] || []).forEach(function (cb) {
      try { cb(payload); } catch (e) { console.error("kura listener error", e); }
    });
  }

  var currentChainId = "0x1";
  var currentAccounts = [];

  async function rpcRequest(args) {
    var method = args && args.method;
    var params = args && args.params || [];
    if (method === "eth_chainId") return currentChainId;
    if (method === "eth_accounts") return currentAccounts;
    if (method === "eth_requestAccounts") {
      var result = await req("/requests", {
        kind: "connect",
        chainId: parseInt(currentChainId, 16) || 1,
        source: "shim:" + ORIGIN,
        origin: ORIGIN,
        payload: { params: params },
      });
      if (result.decision === "approve" && Array.isArray(result.accounts)) {
        currentAccounts = result.accounts;
        emit("accountsChanged", currentAccounts);
        return currentAccounts;
      }
      throw { code: 4001, message: "user rejected" };
    }
    if (method === "wallet_switchEthereumChain") {
      var target = params && params[0] && params[0].chainId;
      if (!target) throw { code: -32602, message: "invalid params" };
      currentChainId = target;
      emit("chainChanged", target);
      return null;
    }
    if (method === "wallet_addEthereumChain") {
      // We don't maintain a known-chain list dapp-side. The daemon's chain
      // list is authoritative; if the chain isn't supported the next eth_call
      // will surface that. Accept silently for now (matches MetaMask UX once
      // the chain is already added).
      var addedChain = params && params[0] && params[0].chainId;
      if (addedChain) {
        currentChainId = addedChain;
        emit("chainChanged", addedChain);
      }
      return null;
    }
    if (method === "wallet_getCapabilities") {
      // EIP-5792: empty caps => "legacy wallet, no atomic batch / paymaster /
      // session keys". Without this, dapps that probe capabilities (Uniswap,
      // newer Aave) may bail before falling back to legacy eth_sendTransaction.
      var capAccount = (params && params[0]) || (currentAccounts[0] || "0x");
      var caps = {};
      caps[capAccount] = {};
      return caps;
    }
    if (method === "wallet_sendCalls") {
      // EIP-5792 atomic batch. We don't implement; dapps must fall back to
      // legacy eth_sendTransaction after seeing -32601.
      throw { code: -32601, message: "kura: wallet_sendCalls not implemented, use eth_sendTransaction" };
    }
    if (method === "wallet_getCallsStatus" || method === "wallet_showCallsStatus") {
      throw { code: -32601, message: "kura: " + method + " not implemented" };
    }
    if (method === "wallet_revokePermissions") {
      // We treat permissions as session-scoped already (DappSession in core/types.ts).
      // Accept silently — kura users revoke via the TUI connections view.
      return null;
    }
    if (method === "wallet_watchAsset") {
      // We don't track tokens client-side; portfolio is derived from on-chain.
      return false;
    }
    if (method === "wallet_requestPermissions") {
      // Dapps use this to ask for eth_accounts permission. Treat as connect.
      var permResult = await req("/requests", {
        kind: "connect",
        chainId: parseInt(currentChainId, 16) || 1,
        source: "shim:" + ORIGIN,
        origin: ORIGIN,
        payload: { params: params, method: method },
      });
      if (permResult.decision === "approve" && Array.isArray(permResult.accounts)) {
        currentAccounts = permResult.accounts;
        emit("accountsChanged", currentAccounts);
        return [{ parentCapability: "eth_accounts", caveats: [{ type: "restrictReturnedAccounts", value: currentAccounts }] }];
      }
      throw { code: 4001, message: "user rejected" };
    }
    if (method === "wallet_getPermissions") {
      if (currentAccounts.length === 0) return [];
      return [{ parentCapability: "eth_accounts", caveats: [{ type: "restrictReturnedAccounts", value: currentAccounts }] }];
    }
    if (method === "personal_sign" || method === "eth_signTypedData_v4" || method === "eth_sign") {
      var sigResult = await req("/requests", {
        kind: method === "personal_sign" ? "personal_sign" : "eth_signTypedData_v4",
        chainId: parseInt(currentChainId, 16) || 1,
        source: "shim:" + ORIGIN,
        origin: ORIGIN,
        payload: { params: params },
      });
      if (sigResult.decision === "approve") return sigResult.signature || "0x";
      throw { code: 4001, message: "user rejected" };
    }
    if (method === "eth_sendTransaction") {
      var tx = (params && params[0]) || {};
      var txResult = await req("/requests", {
        kind: "eth_sendTransaction",
        chainId: parseInt(currentChainId, 16) || 1,
        source: "shim:" + ORIGIN,
        origin: ORIGIN,
        payload: tx,
      });
      if (txResult.decision === "approve" && txResult.txHash) return txResult.txHash;
      throw { code: 4001, message: txResult.error || "user rejected" };
    }
    if (method && (method.indexOf("eth_") === 0 || method.indexOf("net_") === 0 || method === "web3_clientVersion")) {
      var r;
      try {
        r = await req("/rpc?chain=" + (parseInt(currentChainId, 16) || 1), { method: method, params: params });
      } catch (e) {
        throw { code: -32603, message: "kura: rpc transport failed: " + (e && e.message || e) };
      }
      if (r && r.result !== undefined) return r.result;
      if (r && r.error) {
        var errCode = (r.error && r.error.code) || -32603;
        var errMsg = (r.error && r.error.message) || "kura rpc error";
        throw { code: errCode, message: errMsg };
      }
      throw { code: -32603, message: "kura rpc returned no result" };
    }
    throw { code: -32601, message: "method not supported by kura: " + method };
  }

  var provider = {
    isMetaMask: true,
    isKura: true,
    chainId: currentChainId,
    networkVersion: "1",
    request: rpcRequest,
    enable: function () { return rpcRequest({ method: "eth_requestAccounts" }); },
    sendAsync: function (args, cb) {
      rpcRequest(args).then(function (result) { cb(null, { id: args.id, jsonrpc: "2.0", result: result }); }, function (err) { cb(err); });
    },
    send: function (methodOrArgs, paramsOrCb) {
      if (typeof methodOrArgs === "string") {
        return rpcRequest({ method: methodOrArgs, params: paramsOrCb || [] });
      }
      return this.sendAsync(methodOrArgs, paramsOrCb);
    },
    on: function (event, cb) { (listeners[event] = listeners[event] || []).push(cb); return provider; },
    removeListener: function (event, cb) { listeners[event] = (listeners[event] || []).filter(function (x) { return x !== cb; }); return provider; },
    addListener: function (event, cb) { return provider.on(event, cb); },
    removeAllListeners: function (event) { if (event) delete listeners[event]; else for (var k in listeners) delete listeners[k]; return provider; },
  };

  if (!window.ethereum) {
    Object.defineProperty(window, "ethereum", { value: provider, writable: false, configurable: false });
  }

  var info = {
    uuid: "kura-" + Math.random().toString(36).slice(2),
    name: "kura",
    icon: "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><rect width='64' height='64' fill='%23000'/><text x='32' y='40' fill='%23fff' font-size='28' text-anchor='middle' font-family='monospace'>k</text></svg>",
    rdns: "xyz.kura.wallet",
  };
  function announce() {
    window.dispatchEvent(new CustomEvent("eip6963:announceProvider", {
      detail: Object.freeze({ info: info, provider: provider }),
    }));
  }
  window.addEventListener("eip6963:requestProvider", announce);
  announce();
})();
`;
