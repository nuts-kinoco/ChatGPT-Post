#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <aclapi.h>
#include <sddl.h>
#include <node_api.h>
#include "error-boundary.h"
#include <algorithm>
#include <cstdint>
#include <string>
#include <utility>
#include <vector>

// An observation only. No permission decision, content IO, or retained handle.
namespace {
using archive_inspection::Failure;
struct NativeErrorApi {
  static napi_status pending(napi_env env, bool* result) noexcept { return napi_is_exception_pending(env, result); }
  static napi_status throwError(napi_env env, const char* code, const char* message) noexcept { return napi_throw_error(env, code, message); }
  [[noreturn]] static void fatal(const char* reason) noexcept {
    napi_fatal_error("archive_inspection_error_boundary", NAPI_AUTO_LENGTH, reason, NAPI_AUTO_LENGTH);
  }
};
void check(napi_status status) { if (status != napi_ok) throw Failure("archive_inspection_napi_error"); }
struct Handle {
  HANDLE value = INVALID_HANDLE_VALUE;
  explicit Handle(HANDLE h) : value(h) {}
  ~Handle() { if (value != INVALID_HANDLE_VALUE) CloseHandle(value); }
  Handle(const Handle&) = delete;
  Handle& operator=(const Handle&) = delete;
  Handle(Handle&& other) noexcept : value(std::exchange(other.value, INVALID_HANDLE_VALUE)) {}
};
struct LocalMemory {
  HLOCAL value = nullptr;
  ~LocalMemory() { if (value) LocalFree(value); }
};
std::string hex(const void* data, size_t size) {
  const auto* bytes = static_cast<const unsigned char*>(data);
  constexpr char digits[] = "0123456789abcdef";
  std::string result;
  result.reserve(size * 2);
  for (size_t i = 0; i < size; ++i) { result += digits[bytes[i] >> 4]; result += digits[bytes[i] & 15]; }
  return result;
}
std::wstring upper(std::wstring s) {
  for (auto& c : s) if (c >= L'a' && c <= L'z') c -= L'a' - L'A';
  return s;
}
std::vector<std::wstring> ancestors(const std::wstring& path) {
  if (path.size() < 3 || path.size() > 4096 || path[0] < L'A' || path[0] > L'Z' ||
      path[1] != L':' || path[2] != L'\\') throw Failure("archive_inspection_invalid_path");
  std::vector<std::wstring> result{path.substr(0, 3)};
  size_t start = 3;
  while (start < path.size()) {
    size_t end = path.find(L'\\', start);
    if (end == std::wstring::npos) end = path.size();
    const auto component = path.substr(start, end - start);
    if (component.empty() || component.back() == L'.' || component.back() == L' ')
      throw Failure("archive_inspection_invalid_path");
    for (wchar_t c : component) if (c < 32 || std::wstring(L"<>:\"/|?*").find(c) != std::wstring::npos)
      throw Failure("archive_inspection_invalid_path");
    auto stem = upper(component.substr(0, component.find(L'.')));
    if (stem == L"CON" || stem == L"PRN" || stem == L"AUX" || stem == L"NUL" ||
        stem == L"CONIN$" || stem == L"CONOUT$" ||
        (stem.size() == 4 && (stem.substr(0, 3) == L"COM" || stem.substr(0, 3) == L"LPT") &&
         (stem[3] >= L'1' && stem[3] <= L'9' || stem[3] == 0xb9 || stem[3] == 0xb2 || stem[3] == 0xb3)))
      throw Failure("archive_inspection_invalid_path");
    result.push_back(path.substr(0, end));
    if (result.size() > 128 || end + 1 == path.size()) throw Failure("archive_inspection_invalid_path");
    start = end + 1;
  }
  return result;
}
Handle open(const std::wstring& path) {
  const std::wstring extended = L"\\\\?\\" + path;
  HANDLE h = CreateFileW(extended.c_str(), READ_CONTROL | FILE_READ_ATTRIBUTES,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING,
      FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
  if (h == INVALID_HANDLE_VALUE) throw Failure("archive_inspection_open_failed", GetLastError());
  return Handle(h);
}
struct Snapshot {
  std::string volume, id, owner, dacl;
  std::wstring finalPath;
  DWORD attributes = 0, tag = 0, links = 0;
  bool directory = false, protectedDacl = false;
  std::vector<unsigned int> aceTypes;
  bool operator==(const Snapshot& b) const {
    return volume == b.volume && id == b.id && owner == b.owner && dacl == b.dacl &&
      finalPath == b.finalPath && attributes == b.attributes && tag == b.tag &&
      links == b.links && directory == b.directory && protectedDacl == b.protectedDacl && aceTypes == b.aceTypes;
  }
};
Snapshot read(HANDLE h) {
  Snapshot s;
  FILE_ID_INFO id{};
  FILE_ATTRIBUTE_TAG_INFO tag{};
  FILE_STANDARD_INFO standard{};
  if (!GetFileInformationByHandleEx(h, FileIdInfo, &id, sizeof(id)) ||
      !GetFileInformationByHandleEx(h, FileAttributeTagInfo, &tag, sizeof(tag)) ||
      !GetFileInformationByHandleEx(h, FileStandardInfo, &standard, sizeof(standard)))
    throw Failure("archive_inspection_metadata_failed", GetLastError());
  s.volume = hex(&id.VolumeSerialNumber, sizeof(id.VolumeSerialNumber));
  s.id = hex(id.FileId.Identifier, sizeof(id.FileId.Identifier));
  s.attributes = tag.FileAttributes; s.tag = tag.ReparseTag;
  s.directory = standard.Directory != FALSE; s.links = standard.NumberOfLinks;
  if ((s.attributes & FILE_ATTRIBUTE_REPARSE_POINT) || s.tag)
    throw Failure("archive_inspection_reparse_point");
  if (standard.DeletePending) throw Failure("archive_inspection_delete_pending");
  DWORD length = GetFinalPathNameByHandleW(h, nullptr, 0, FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
  if (!length || length > 32768) throw Failure("archive_inspection_final_path_failed", GetLastError());
  std::vector<wchar_t> finalPath(length + 1);
  DWORD written = GetFinalPathNameByHandleW(h, finalPath.data(), static_cast<DWORD>(finalPath.size()), FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
  if (!written || written >= finalPath.size()) throw Failure("archive_inspection_final_path_failed", GetLastError());
  s.finalPath.assign(finalPath.data(), written);
  if (s.finalPath.substr(0, 4) != L"\\\\?\\") throw Failure("archive_inspection_unknown_path");
  s.finalPath.erase(0, 4);
  PSID owner = nullptr; PACL dacl = nullptr; PSECURITY_DESCRIPTOR sd = nullptr;
  DWORD error = GetSecurityInfo(h, SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
                               &owner, nullptr, &dacl, nullptr, &sd);
  LocalMemory descriptor; descriptor.value = sd;
  if (error != ERROR_SUCCESS) throw Failure("archive_inspection_security_failed", error);
  if (!sd || !IsValidSecurityDescriptor(sd) || !owner || !IsValidSid(owner))
    throw Failure("archive_inspection_unknown_security");
  BOOL present = FALSE, defaulted = FALSE; PACL verifiedDacl = nullptr;
  if (!GetSecurityDescriptorDacl(sd, &present, &verifiedDacl, &defaulted) || !present || !dacl || dacl != verifiedDacl || !IsValidAcl(dacl))
    throw Failure("archive_inspection_unknown_dacl");
  SECURITY_DESCRIPTOR_CONTROL control{}; DWORD revision = 0;
  if (!GetSecurityDescriptorControl(sd, &control, &revision)) throw Failure("archive_inspection_security_failed", GetLastError());
  s.protectedDacl = (control & SE_DACL_PROTECTED) != 0;
  LPWSTR ownerString = nullptr;
  if (!ConvertSidToStringSidW(owner, &ownerString)) throw Failure("archive_inspection_security_failed", GetLastError());
  LocalMemory sid; sid.value = ownerString;
  for (const wchar_t* p = ownerString; *p; ++p) s.owner += static_cast<char>(*p);
  if (dacl->AclSize > 65535 || dacl->AceCount > 4096) throw Failure("archive_inspection_security_limit");
  for (DWORD i = 0; i < dacl->AceCount; ++i) {
    void* raw = nullptr;
    if (!GetAce(dacl, i, &raw)) throw Failure("archive_inspection_security_failed", GetLastError());
    const auto* ace = static_cast<const ACE_HEADER*>(raw);
    if (ace->AceType != ACCESS_ALLOWED_ACE_TYPE && ace->AceType != ACCESS_DENIED_ACE_TYPE)
      throw Failure("archive_inspection_unsupported_ace");
    s.aceTypes.push_back(ace->AceType);
  }
  s.dacl = hex(dacl, dacl->AclSize);
  return s;
}
napi_value object(napi_env env) { napi_value v; check(napi_create_object(env, &v)); return v; }
void property(napi_env env, napi_value obj, const char* key, napi_value value) { check(napi_set_named_property(env, obj, key, value)); }
napi_value string(napi_env env, const std::string& text) { napi_value v; check(napi_create_string_utf8(env, text.data(), text.size(), &v)); return v; }
napi_value wide(napi_env env, const std::wstring& text) { napi_value v; check(napi_create_string_utf16(env, reinterpret_cast<const char16_t*>(text.data()), text.size(), &v)); return v; }
napi_value number(napi_env env, uint32_t n) { napi_value v; check(napi_create_uint32(env, n, &v)); return v; }
napi_value boolean(napi_env env, bool b) { napi_value v; check(napi_get_boolean(env, b, &v)); return v; }
napi_value inspect(napi_env env, napi_callback_info info) noexcept {
  return archive_inspection::boundary<NativeErrorApi>(env, [&]() -> napi_value {
    size_t count = 2; napi_value args[2]; check(napi_get_cb_info(env, info, &count, args, nullptr, nullptr));
    napi_valuetype type;
    if (count != 1) throw Failure("archive_inspection_invalid_argument");
    check(napi_typeof(env, args[0], &type));
    if (type != napi_string) throw Failure("archive_inspection_invalid_argument");
    size_t length = 0; check(napi_get_value_string_utf16(env, args[0], nullptr, 0, &length));
    if (length > 4096) throw Failure("archive_inspection_invalid_path");
    std::vector<char16_t> buffer(length + 1);
    size_t copied = 0; check(napi_get_value_string_utf16(env, args[0], buffer.data(), buffer.size(), &copied));
    std::wstring path(reinterpret_cast<const wchar_t*>(buffer.data()), copied);
    const auto chain = ancestors(path);
    std::vector<Handle> handles; std::vector<Snapshot> snapshots;
    for (size_t i = 0; i < chain.size(); ++i) {
      handles.push_back(open(chain[i]));
      auto s = read(handles.back().value);
      if (CompareStringOrdinal(s.finalPath.c_str(), -1, chain[i].c_str(), -1, TRUE) != CSTR_EQUAL)
        throw Failure("archive_inspection_path_mismatch");
      if (i + 1 < chain.size() && !s.directory) throw Failure("archive_inspection_ancestor_not_directory");
      if (!(s == read(handles.back().value))) throw Failure("archive_inspection_changed");
      snapshots.push_back(std::move(s));
    }
    // Hold every handle, then re-open each name and compare with its handle snapshot.
    // This detects some changes; it does not make a pathname traversal atomic.
    for (size_t i = 0; i < chain.size(); ++i) {
      auto reopened = open(chain[i]);
      if (!(snapshots[i] == read(handles[i].value)) || !(snapshots[i] == read(reopened.value)))
        throw Failure("archive_inspection_changed");
    }
    napi_value result = object(env), entries;
    property(env, result, "schema", string(env, "archive-win32-observation-1"));
    check(napi_create_array_with_length(env, snapshots.size(), &entries));
    for (size_t i = 0; i < snapshots.size(); ++i) {
      const auto& s = snapshots[i]; napi_value entry = object(env), aceTypes;
      property(env, entry, "path", wide(env, chain[i]));
      property(env, entry, "finalPath", wide(env, s.finalPath));
      property(env, entry, "volumeSerialBytes", string(env, s.volume));
      property(env, entry, "fileId128", string(env, s.id));
      property(env, entry, "ownerSid", string(env, s.owner));
      property(env, entry, "daclHex", string(env, s.dacl));
      property(env, entry, "daclProtected", boolean(env, s.protectedDacl));
      property(env, entry, "attributes", number(env, s.attributes));
      property(env, entry, "reparseTag", number(env, s.tag));
      property(env, entry, "linkCount", number(env, s.links));
      property(env, entry, "directory", boolean(env, s.directory));
      check(napi_create_array_with_length(env, s.aceTypes.size(), &aceTypes));
      for (size_t a = 0; a < s.aceTypes.size(); ++a) check(napi_set_element(env, aceTypes, static_cast<uint32_t>(a), number(env, s.aceTypes[a])));
      property(env, entry, "aceTypes", aceTypes);
      check(napi_set_element(env, entries, static_cast<uint32_t>(i), entry));
    }
    property(env, result, "entries", entries);
    return result;
  });
}
static_assert(noexcept(inspect(nullptr, nullptr)), "Node-API callback must not throw C++ exceptions");
}
NAPI_MODULE_INIT() {
  return archive_inspection::boundary<NativeErrorApi>(env, [&]() -> napi_value {
    napi_value fn;
    check(napi_create_function(env, "inspectChain", NAPI_AUTO_LENGTH, inspect, nullptr, &fn));
    check(napi_set_named_property(env, exports, "inspectChain", fn));
    return exports;
  });
}
