// Standalone fault injection for the exact header used by the Node callback.
// No Win32 metadata, V8, filesystem, or runtime policy operations.
#include "error-boundary.h"
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <new>
#include <string>

namespace {
bool denyAllocations = false;
unsigned int allocationAttempts = 0;
struct State {
  bool pending = false, installException = true;
  unsigned int pendingCalls = 0, throwCalls = 0, failPendingCall = 0;
  napi_status throwStatus = napi_ok;
  const char* expectedFatal = nullptr;
  char code[160]{}, message[160]{};
} state;
struct FakeApi {
  static napi_status pending(napi_env, bool* result) noexcept {
    if (++state.pendingCalls == state.failPendingCall) return napi_generic_failure;
    *result = state.pending;
    return napi_ok;
  }
  static napi_status throwError(napi_env, const char* code, const char* message) noexcept {
    ++state.throwCalls;
    std::memcpy(state.code, code, std::strlen(code) + 1);
    std::memcpy(state.message, message, std::strlen(message) + 1);
    state.pending = state.installException;
    return state.throwStatus;
  }
  [[noreturn]] static void fatal(const char* reason) noexcept {
    // Nonzero sentinel exit in this owned test process only. Production calls
    // napi_fatal_error; no test fault switches exist in the shipped addon.
    std::exit(state.expectedFatal && std::strcmp(reason, state.expectedFatal) == 0 ? 73 : 74);
  }
};
void require(bool result) { if (!result) std::exit(1); }
void reset() { state = State{}; denyAllocations = false; allocationAttempts = 0; }
struct Cleanup {
  bool& ran;
  ~Cleanup() noexcept { ran = true; }
};
}
void* operator new(std::size_t size) {
  if (denyAllocations) { ++allocationAttempts; throw std::bad_alloc(); }
  if (void* p = std::malloc(size ? size : 1)) return p;
  throw std::bad_alloc();
}
void operator delete(void* p) noexcept { std::free(p); }
void operator delete(void* p, std::size_t) noexcept { std::free(p); }
void* operator new[](std::size_t size) { return ::operator new(size); }
void operator delete[](void* p) noexcept { std::free(p); }
void operator delete[](void* p, std::size_t) noexcept { std::free(p); }

int main(int argc, char** argv) {
  using archive_inspection::boundary;
  using archive_inspection::Failure;
  static_assert(noexcept(archive_inspection::reportError<FakeApi>(nullptr, "code", 0)));
  reset();
  if (argc == 2) {
    if (std::strcmp(argv[1], "pending-query-fails") == 0) {
      state.failPendingCall = 1; state.expectedFatal = "exception_state_unavailable";
    } else if (std::strcmp(argv[1], "post-throw-query-fails") == 0) {
      state.failPendingCall = 2; state.expectedFatal = "exception_state_unavailable";
    } else if (std::strcmp(argv[1], "throw-fails-no-pending") == 0) {
      state.throwStatus = napi_generic_failure; state.installException = false;
      state.expectedFatal = "exception_throw_failed";
    } else if (std::strcmp(argv[1], "throw-ok-no-pending") == 0) {
      state.installException = false; state.expectedFatal = "exception_not_pending";
    } else return 2;
    denyAllocations = true;
    boundary<FakeApi>(nullptr, []() -> napi_value { throw Failure("archive_inspection_napi_error"); });
    return 3; // Returning silently must never happen in these cases.
  }

  napi_value marker = reinterpret_cast<napi_value>(&state);
  require(boundary<FakeApi>(nullptr, [&]() { return marker; }) == marker);
  require(state.pendingCalls == 0 && state.throwCalls == 0);

  reset(); denyAllocations = true;
  require(boundary<FakeApi>(nullptr, []() -> napi_value {
    throw Failure("archive_inspection_open_failed", UINT32_MAX);
  }) == nullptr);
  require(allocationAttempts == 0 && state.throwCalls == 1 && state.pending);
  require(std::strcmp(state.message, "archive_inspection_open_failed (win32=4294967295)") == 0);

  reset(); denyAllocations = true;
  bool cleaned = false;
  require(boundary<FakeApi>(nullptr, [&]() -> napi_value {
    Cleanup cleanup{cleaned};
    std::string allocation(4096, 'x'); // Actual operator-new failure in the body.
    return reinterpret_cast<napi_value>(allocation.data());
  }) == nullptr);
  require(cleaned && allocationAttempts == 1 && state.pending);
  require(std::strcmp(state.code, "archive_inspection_internal_error") == 0);
  require(std::strcmp(state.message, "archive_inspection_internal_error (win32=0)") == 0);

  reset(); state.pending = true; denyAllocations = true;
  require(boundary<FakeApi>(nullptr, []() -> napi_value {
    throw Failure("archive_inspection_napi_error");
  }) == nullptr);
  require(state.pending && state.throwCalls == 0 && allocationAttempts == 0);

  reset(); state.throwStatus = napi_generic_failure; denyAllocations = true;
  require(boundary<FakeApi>(nullptr, []() -> napi_value {
    throw Failure("archive_inspection_napi_error");
  }) == nullptr);
  require(state.pending && state.pendingCalls == 2 && state.throwCalls == 1 && allocationAttempts == 0);
  denyAllocations = false;
  std::puts("5 boundary cases passed");
  return 0;
}
