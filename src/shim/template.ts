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

  function req(path, body) {
    return new Promise(function (resolve, reject) {
      if (!gm) {
        fetch(BASE + path, {
          method: body ? "POST" : "GET",
          headers: { "X-Kura-Key": SECRET, "Content-Type": "application/json" },
          body: body ? JSON.stringify(body) : undefined,
        }).then(function (r) { return r.json(); }).then(resolve, reject);
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
          var info = "kura GM.xhr error: status=" + (e && e.status) + " statusText=" + (e && e.statusText) + " readyState=" + (e && e.readyState);
          console.error(info, e);
          reject(new Error(info));
        },
        ontimeout: function () { reject(new Error("kura GM.xhr timeout")); },
      });
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
    if (method && method.indexOf("eth_") === 0) {
      var r = await fetch(BASE + "/rpc?chain=" + (parseInt(currentChainId, 16) || 1), {
        method: "POST",
        headers: { "X-Kura-Key": SECRET, "Content-Type": "application/json" },
        body: JSON.stringify({ method: method, params: params }),
      }).then(function (r) { return r.json(); }).catch(function () { return { error: "kura rpc failed" }; });
      if (r && r.result !== undefined) return r.result;
      throw { code: -32603, message: (r && r.error) || "kura rpc failed" };
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
