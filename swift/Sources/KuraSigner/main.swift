// kura-signer
// Touch ID gated wallet key storage on macOS Keychain.
// Subcommands:
//   has <name>                  exit 0 if entry exists, 1 otherwise. No prompt.
//   store <name>                read hex private key from stdin, store. No prompt.
//   get <name> [-m <reason>]    print the hex key. Prompts Touch ID (or password fallback).
//   delete <name> [-m <reason>] delete the entry. Prompts Touch ID (or password fallback).
//   auth [-m <reason>]          standalone biometry gate (no keychain).
// Exit codes: 0 success, 2 user cancelled biometry, 3 keychain entry not found, 1 other error.
//
// Touch ID is enforced via LAContext.evaluatePolicy(.deviceOwnerAuthentication, ...) before
// the keychain read, NOT via kSecAttrAccessControl. This avoids needing a paid Apple Developer
// cert (the kSecAccessControl + .biometryCurrentSet path errors with -34018 errSecMissingEntitlement
// on unsigned binaries). Pattern borrowed from pragma-signer's SecureEnclave.swift.
//
// .deviceOwnerAuthentication (not WithBiometrics) lets the OS fall back to the Mac password if
// biometry is hardware-disabled or repeatedly failing, so the user is never locked out.

import Foundation
import Security
import LocalAuthentication

enum SignerError: Error {
  case unsupported(String)
  case keychain(OSStatus)
  case bioFailed(String)
  case bioCancelled
  case notFound
  case invalidInput(String)
}

func service(_ name: String) -> String { "xyz.\(name).kura" }
let account = "key"
let label = "kura wallet key"

func authGate(reason: String) throws {
  let ctx = LAContext()
  var err: NSError?
  guard ctx.canEvaluatePolicy(.deviceOwnerAuthentication, error: &err) else {
    throw SignerError.bioFailed(err?.localizedDescription ?? "device authentication unavailable")
  }
  let semaphore = DispatchSemaphore(value: 0)
  var ok = false
  var resultErr: Error?
  ctx.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason) { success, error in
    ok = success
    resultErr = error
    semaphore.signal()
  }
  semaphore.wait()
  guard ok else {
    if let laErr = resultErr as? LAError {
      switch laErr.code {
      case .userCancel, .systemCancel, .appCancel:
        throw SignerError.bioCancelled
      default:
        throw SignerError.bioFailed(laErr.localizedDescription)
      }
    }
    throw SignerError.bioFailed("authentication failed")
  }
}

func storeKey(name: String, hex: String) throws {
  let svc = service(name)
  guard let data = hex.data(using: .utf8) else {
    throw SignerError.invalidInput("not utf8")
  }

  let deleteQuery: [String: Any] = [
    kSecClass as String: kSecClassGenericPassword,
    kSecAttrService as String: svc,
    kSecAttrAccount as String: account,
  ]
  SecItemDelete(deleteQuery as CFDictionary)

  let addQuery: [String: Any] = [
    kSecClass as String: kSecClassGenericPassword,
    kSecAttrService as String: svc,
    kSecAttrAccount as String: account,
    kSecAttrLabel as String: label,
    kSecAttrDescription as String: "kura signing key (Touch ID gated via LAContext)",
    kSecValueData as String: data,
    kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
  ]

  let status = SecItemAdd(addQuery as CFDictionary, nil)
  if status != errSecSuccess {
    throw SignerError.keychain(status)
  }
}

func getKey(name: String, reason: String) throws -> String {
  try authGate(reason: reason)
  let svc = service(name)
  let query: [String: Any] = [
    kSecClass as String: kSecClassGenericPassword,
    kSecAttrService as String: svc,
    kSecAttrAccount as String: account,
    kSecReturnData as String: true,
  ]
  var result: AnyObject?
  let status = SecItemCopyMatching(query as CFDictionary, &result)
  if status == errSecItemNotFound {
    throw SignerError.notFound
  }
  if status != errSecSuccess {
    throw SignerError.keychain(status)
  }
  guard let data = result as? Data, let str = String(data: data, encoding: .utf8) else {
    throw SignerError.notFound
  }
  return str
}

func hasKey(name: String) -> Bool {
  let svc = service(name)
  let query: [String: Any] = [
    kSecClass as String: kSecClassGenericPassword,
    kSecAttrService as String: svc,
    kSecAttrAccount as String: account,
    kSecReturnData as String: false,
    kSecUseAuthenticationUI as String: kSecUseAuthenticationUIFail,
  ]
  let status = SecItemCopyMatching(query as CFDictionary, nil)
  return status == errSecSuccess || status == errSecInteractionNotAllowed
}

func deleteKey(name: String, reason: String) throws {
  try authGate(reason: reason)
  let svc = service(name)
  let query: [String: Any] = [
    kSecClass as String: kSecClassGenericPassword,
    kSecAttrService as String: svc,
    kSecAttrAccount as String: account,
  ]
  let status = SecItemDelete(query as CFDictionary)
  if status != errSecSuccess && status != errSecItemNotFound {
    throw SignerError.keychain(status)
  }
}

func usage() -> Never {
  let stderr = FileHandle.standardError
  let msg = """
  usage:
    kura-signer has <name>
    kura-signer store <name>                       (reads hex from stdin)
    kura-signer get <name> [-m <reason>]
    kura-signer delete <name> [-m <reason>]
    kura-signer auth [-m <reason>]
  """
  if let data = (msg + "\n").data(using: .utf8) {
    stderr.write(data)
  }
  exit(64)
}

func fail(_ message: String, code: Int32 = 1) -> Never {
  let stderr = FileHandle.standardError
  if let data = (message + "\n").data(using: .utf8) {
    stderr.write(data)
  }
  exit(code)
}

// Parse `-m <reason>` from anywhere in args; returns reason and remaining positional args.
func parseReason(_ args: [String], defaultReason: String) -> String {
  var i = 0
  while i < args.count {
    if args[i] == "-m" && i + 1 < args.count {
      return args[i + 1]
    }
    i += 1
  }
  return defaultReason
}

let args = CommandLine.arguments
if args.count < 2 { usage() }
let cmd = args[1]
let rest = Array(args.dropFirst(2))

// Split positional (non-flag) args from the flag pairs so commands that take a name still work.
var positionals: [String] = []
var i = 0
while i < rest.count {
  if rest[i] == "-m" {
    i += 2
    continue
  }
  positionals.append(rest[i])
  i += 1
}

switch cmd {
case "has":
  guard let name = positionals.first else { usage() }
  exit(hasKey(name: name) ? 0 : 1)

case "store":
  guard let name = positionals.first else { usage() }
  let hex = String(decoding: FileHandle.standardInput.availableData, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
  if hex.isEmpty { fail("kura-signer store: empty stdin") }
  do {
    try storeKey(name: name, hex: hex)
    print("ok")
  } catch SignerError.keychain(let s) { fail("kura-signer store: keychain status \(s)") }
    catch { fail("kura-signer store: \(error)") }

case "get":
  guard let name = positionals.first else { usage() }
  let reason = parseReason(rest, defaultReason: "kura: read \(name) key")
  do {
    let v = try getKey(name: name, reason: reason)
    print(v)
  } catch SignerError.bioCancelled { fail("kura-signer get: cancelled", code: 2) }
    catch SignerError.bioFailed(let m) { fail("kura-signer get: bio failed: \(m)") }
    catch SignerError.notFound { fail("kura-signer get: not found", code: 3) }
    catch SignerError.keychain(let s) { fail("kura-signer get: keychain status \(s)") }
    catch { fail("kura-signer get: \(error)") }

case "delete":
  guard let name = positionals.first else { usage() }
  let reason = parseReason(rest, defaultReason: "kura: delete \(name) key")
  do {
    try deleteKey(name: name, reason: reason)
    print("ok")
  } catch SignerError.bioCancelled { fail("kura-signer delete: cancelled", code: 2) }
    catch SignerError.bioFailed(let m) { fail("kura-signer delete: bio failed: \(m)") }
    catch SignerError.keychain(let s) { fail("kura-signer delete: keychain status \(s)") }
    catch { fail("kura-signer delete: \(error)") }

case "auth":
  let reason = parseReason(rest, defaultReason: "kura authentication")
  do {
    try authGate(reason: reason)
    print("ok")
  } catch SignerError.bioCancelled { fail("kura-signer auth: cancelled", code: 2) }
    catch SignerError.bioFailed(let m) { fail("kura-signer auth: bio failed: \(m)") }
    catch { fail("kura-signer auth: \(error)") }

default:
  usage()
}
