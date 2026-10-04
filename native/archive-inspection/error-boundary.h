#pragma once
#include <node_api.h>
#include <cstdint>

namespace archive_inspection {
// Codes are internal literals; constructing Failure performs no C++ heap allocation.
// Throwing can allocate in the C++ exception runtime; that allocation is not guaranteed.
struct Failure {
  const char* code;
  uint32_t win32;
  explicit constexpr Failure(const char* value, uint32_t error = 0) noexcept : code(value), win32(error) {}
};

template<class Api>
void reportError(napi_env env, const char* code, uint32_t win32) noexcept {
  bool pending = false;
  if (Api::pending(env, &pending) != napi_ok) Api::fatal("exception_state_unavailable");
  if (pending) return; // Preserve the existing JS exception; never clear/replace it.

  char message[160]{};
  size_t length = 0;
  for (size_t i = 0; code[i] && length < 120; ++i) message[length++] = code[i];
  for (char c : " (win32=") if (c) message[length++] = c;
  char digits[10]; size_t count = 0;
  do { digits[count++] = static_cast<char>('0' + win32 % 10); win32 /= 10; } while (win32);
  while (count) message[length++] = digits[--count];
  message[length++] = ')'; message[length] = '\0';

  const napi_status thrown = Api::throwError(env, code, message);
  // A failing N-API call can still leave a JS exception pending. Confirm it before
  // returning, including when throwError reports success. No silent undefined.
  pending = false;
  if (Api::pending(env, &pending) != napi_ok) Api::fatal("exception_state_unavailable");
  if (!pending) Api::fatal(thrown == napi_ok ? "exception_not_pending" : "exception_throw_failed");
}

template<class Api, class Body>
napi_value boundary(napi_env env, Body&& body) noexcept {
  try { return body(); }
  catch (const Failure& error) { reportError<Api>(env, error.code, error.win32); }
  catch (...) { reportError<Api>(env, "archive_inspection_internal_error", 0); }
  return nullptr;
}
}
