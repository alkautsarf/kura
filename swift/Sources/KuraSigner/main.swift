// kura-signer
// Touch ID gated wallet key storage on macOS Keychain.
// Subcommands:
//   has <name>           exit 0 if entry exists, 1 otherwise. No Touch ID.
//   store <name>         read hex private key from stdin, store in Keychain.
//                        Touch ID required to enable biometry-gated read on later get.
//   get <name>           print the hex private key to stdout. Touch ID required.
//   delete <name>        delete the entry. Touch ID required.

import Foundation
import Security
import LocalAuthentication

enum SignerError: Error {
  case unsupported(String)
  case keychain(OSStatus)
  case bioFailed(String)
  case notFound
  case invalidInput(String)
}

func service(_ name: String) -> String { "xyz.\(name).kura" }
let account = "key"
let label = "kura wallet key"

func authTouchID(reason: String) throws -> LAContext {
  let ctx = LAContext()
  var err: NSError?
  guard ctx.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &err) else {
    throw SignerError.bioFailed(err?.localizedDescription ?? "biometry unavailable")
  }
  let semaphore = DispatchSemaphore(value: 0)
  var ok = false
  var resultErr: Error?
  ctx.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, localizedReason: reason) { success, error in
    ok = success
    resultErr = error
    semaphore.signal()
  }
  semaphore.wait()
  guard ok else {
    if let laErr = resultErr as? LAError {
      throw SignerError.bioFailed(laErr.localizedDescription)
    }
    throw SignerError.bioFailed("touch id failed")
  }
  return ctx
}

func storeKey(name: String, hex: String) throws {
  let svc = service(name)
  // Touch ID up front so the user grants biometric ownership before the entry is created
  _ = try authTouchID(reason: "Authorize new kura wallet \(name)")
  guard let data = hex.data(using: .utf8) else {
    throw SignerError.invalidInput("not utf8")
  }

  // Delete any existing entry (no Touch ID for delete during initial store)
  let deleteQuery: [String: Any] = [
    kSecClass as String: kSecClassGenericPassword,
    kSecAttrService as String: svc,
    kSecAttrAccount as String: account,
  ]
  SecItemDelete(deleteQuery as CFDictionary)

  // Build SecAccessControl requiring biometry for every access
  var acError: Unmanaged<CFError>?
  guard let access = SecAccessControlCreateWithFlags(
    nil,
    kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
    .biometryCurrentSet,
    &acError
  ) else {
    let cf = acError?.takeRetainedValue()
    throw SignerError.bioFailed(cf?.localizedDescription ?? "access-control creation failed")
  }

  let addQuery: [String: Any] = [
    kSecClass as String: kSecClassGenericPassword,
    kSecAttrService as String: svc,
    kSecAttrAccount as String: account,
    kSecAttrLabel as String: label,
    kSecAttrDescription as String: "kura signing key (Touch ID gated)",
    kSecValueData as String: data,
    kSecAttrAccessControl as String: access,
  ]

  let status = SecItemAdd(addQuery as CFDictionary, nil)
  if status != errSecSuccess {
    throw SignerError.keychain(status)
  }
}

func getKey(name: String) throws -> String {
  let svc = service(name)
  let ctx = try authTouchID(reason: "kura wants to sign with \(name)")
  let query: [String: Any] = [
    kSecClass as String: kSecClassGenericPassword,
    kSecAttrService as String: svc,
    kSecAttrAccount as String: account,
    kSecReturnData as String: true,
    kSecUseAuthenticationContext as String: ctx,
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
  // If the item exists we get errSecInteractionNotAllowed because we asked the call to fail
  // rather than prompt for biometry. Either of these means it exists.
  return status == errSecSuccess || status == errSecInteractionNotAllowed
}

func deleteKey(name: String) throws {
  let svc = service(name)
  _ = try authTouchID(reason: "Delete kura wallet \(name)")
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
  let msg = "usage: kura-signer (has|store|get|delete) <name>\n  store reads hex private key from stdin\n"
  if let data = msg.data(using: .utf8) {
    stderr.write(data)
  }
  exit(64)
}

func fail(_ message: String) -> Never {
  let stderr = FileHandle.standardError
  if let data = (message + "\n").data(using: .utf8) {
    stderr.write(data)
  }
  exit(1)
}

let args = CommandLine.arguments
if args.count < 3 { usage() }
let cmd = args[1]
let name = args[2]

switch cmd {
case "has":
  exit(hasKey(name: name) ? 0 : 1)
case "store":
  let hex = String(decoding: FileHandle.standardInput.availableData, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
  if hex.isEmpty { fail("kura-signer store: empty stdin") }
  do {
    try storeKey(name: name, hex: hex)
    print("ok")
  } catch SignerError.bioFailed(let m) { fail("kura-signer store: bio failed: \(m)") }
    catch SignerError.keychain(let s) { fail("kura-signer store: keychain status \(s)") }
    catch { fail("kura-signer store: \(error)") }
case "get":
  do {
    let v = try getKey(name: name)
    print(v)
  } catch SignerError.bioFailed(let m) { fail("kura-signer get: bio failed: \(m)") }
    catch SignerError.notFound { fail("kura-signer get: not found") }
    catch SignerError.keychain(let s) { fail("kura-signer get: keychain status \(s)") }
    catch { fail("kura-signer get: \(error)") }
case "delete":
  do {
    try deleteKey(name: name)
    print("ok")
  } catch SignerError.bioFailed(let m) { fail("kura-signer delete: bio failed: \(m)") }
    catch SignerError.keychain(let s) { fail("kura-signer delete: keychain status \(s)") }
    catch { fail("kura-signer delete: \(error)") }
default:
  usage()
}
