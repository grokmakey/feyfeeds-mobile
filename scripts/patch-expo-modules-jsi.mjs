import fs from 'node:fs';
import path from 'node:path';

function findExpoModulesJSI() {
  const cwd = process.cwd();
  const roots = [
    cwd,
    path.join(cwd, 'apps', 'mobile'),
    path.join(cwd, '..'),
    path.join(cwd, '..', 'apps', 'mobile'),
  ];

  const seen = new Set();

  function walk(dir, depth = 0) {
    if (depth > 6) return null;
    if (!fs.existsSync(dir)) return null;
    if (seen.has(dir)) return null;
    seen.add(dir);

    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        if (entry.name === 'expo-modules-jsi') {
          return fullPath;
        }

        const result = walk(fullPath, depth + 1);
        if (result) return result;
      }
    }

    return null;
  }

  for (const root of roots) {
    const directPackage = path.join(root, 'node_modules', 'expo-modules-jsi');
    if (fs.existsSync(directPackage)) return directPackage;

    const result = walk(path.join(root, 'node_modules'), 0);
    if (result) return result;
  }

  return null;
}

const basePath = findExpoModulesJSI();
if (!basePath) {
  console.log('expo-modules-jsi not found, skipping patch.');
  process.exit(0);
}

console.log(`Patching expo-modules-jsi at ${basePath} for Xcode 16 / Swift 6.1 compatibility...`);

// 1. Package.swift
const packageSwiftPath = path.join(basePath, 'apple/Package.swift');
if (fs.existsSync(packageSwiftPath)) {
  let content = fs.readFileSync(packageSwiftPath, 'utf8');
  content = content.replace(/swift-tools-version:\s*6\.2/g, 'swift-tools-version: 6.0');
  fs.writeFileSync(packageSwiftPath, content, 'utf8');
  console.log('✓ Patched Package.swift tools-version to 6.0');
}

// 2. Replace weak let with nonisolated(unsafe) weak var across all Swift files
function patchSwiftFiles(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      patchSwiftFiles(fullPath);
    } else if (entry.name.endsWith('.swift')) {
      let content = fs.readFileSync(fullPath, 'utf8');
      if (content.includes('weak let')) {
        content = content.replace(/weak let/g, 'nonisolated(unsafe) weak var');
        fs.writeFileSync(fullPath, content, 'utf8');
        console.log(`✓ Patched weak let in ${entry.name}`);
      }
    }
  }
}
const sourcesPath = path.join(basePath, 'apple/Sources');
if (fs.existsSync(sourcesPath)) {
  patchSwiftFiles(sourcesPath);
}

// 3. Task+immediate.swift
const taskImmediatePath = path.join(basePath, 'apple/Sources/ExpoModulesJSI/Extensions/Task+immediate.swift');
if (fs.existsSync(taskImmediatePath)) {
  const polyfill = `// swift-format-ignore-file: AlwaysUseLowerCamelCase

extension Task where Failure == any Error {
  @discardableResult
  public static func immediate_polyfill(
    name: String? = nil,
    priority: TaskPriority? = nil,
    @_inheritActorContext @_implicitSelfCapture operation: sending @escaping @isolated(any) () async throws -> Success
  ) -> Task<Success, any Error> {
    return Task(priority: .high, operation: operation)
  }
}
`;
  fs.writeFileSync(taskImmediatePath, polyfill, 'utf8');
  console.log('✓ Patched Task+immediate.swift to standard Swift 6.1 Task constructor');
}

// 4. HostFunctionClosure.h
const hostFuncPath = path.join(basePath, 'apple/Sources/ExpoModulesJSI-Cxx/include/HostFunctionClosure.h');
if (fs.existsSync(hostFuncPath)) {
  let content = fs.readFileSync(hostFuncPath, 'utf8');
  content = content.replace(
    'static inline HostFunctionClosure *create(',
    'static inline HostFunctionClosure *_Nonnull create('
  );
  if (!content.includes('static inline HostFunctionClosure *_Nonnull create')) {
    content = content.replace(
      'explicit HostFunctionClosure(Context context, Closure closure, Deallocator deallocator) : RetainedSwiftPointer(context, deallocator), _closure(closure) {};',
      `explicit HostFunctionClosure(Context context, Closure closure, Deallocator deallocator) : RetainedSwiftPointer(context, deallocator), _closure(closure) {};

  static inline HostFunctionClosure *_Nonnull create(Context context, Closure closure, Deallocator deallocator) {
    return new HostFunctionClosure(context, closure, deallocator);
  }`
    );
  }
  fs.writeFileSync(hostFuncPath, content, 'utf8');
  console.log('✓ Added static create() to HostFunctionClosure.h');
}

// 4b. HostObjectCallbacks.h - C++ move helper for non-copyable PropNameID vector
const hostObjCallbacksPath = path.join(basePath, 'apple/Sources/ExpoModulesJSI-Cxx/include/HostObjectCallbacks.h');
if (fs.existsSync(hostObjCallbacksPath)) {
  let content = fs.readFileSync(hostObjCallbacksPath, 'utf8');
  if (!content.includes('#include "IRuntimeCompat.h"')) {
    content = content.replace(
      '#include "RetainedSwiftPointer.h"',
      '#include "RetainedSwiftPointer.h"\n#include "IRuntimeCompat.h"'
    );
  }
  if (!content.includes('pushPropNameId')) {
    content = content.replace(
      '} SWIFT_NONCOPYABLE; // class HostObjectCallbacks',
      `} SWIFT_NONCOPYABLE; // class HostObjectCallbacks

inline void pushPropNameId(HostObjectCallbacks::PropNameIds *_Nonnull vector, facebook::jsi::IRuntime &runtime, const std::string &name) {
  vector->push_back(facebook::jsi::PropNameID::forUtf8(runtime, name));
}`
    );
  }
  fs.writeFileSync(hostObjCallbacksPath, content, 'utf8');
  console.log('✓ Added pushPropNameId() C++ move helper to HostObjectCallbacks.h');
}

// 5. JavaScriptRuntime.swift
const jsRuntimePath = path.join(basePath, 'apple/Sources/ExpoModulesJSI/Runtime/JavaScriptRuntime.swift');
if (fs.existsSync(jsRuntimePath)) {
  let content = fs.readFileSync(jsRuntimePath, 'utf8');
  content = content.replace(
    '_ arguments: consuming JavaScriptValuesBuffer,',
    '_ arguments: consuming JavaScriptValuesBuffer'
  );
  content = content.replace(
    /let propNameId = facebook\.jsi\.PropNameID\.forUtf8\(iRuntime, std\.string\(propertyName\)\)\s*\n\s*vector\.push_back\((?:consuming:\s*)?propNameId\)/g,
    'expo.pushPropNameId(&vector, iRuntime, std.string(propertyName))'
  );
  content = content.replace(
    /return expo\.HostFunctionClosure\(context, call, deallocate\)/g,
    'return expo.HostFunctionClosure.create(context, call, deallocate)'
  );
  fs.writeFileSync(jsRuntimePath, content, 'utf8');
  console.log('✓ Patched JavaScriptRuntime.swift (pushPropNameId, HostFunctionClosure.create, trailing comma)');
}

console.log('expo-modules-jsi patching completed successfully.');
