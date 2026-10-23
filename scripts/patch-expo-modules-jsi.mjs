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

function patchPodfile() {
  const candidates = [
    path.join(process.cwd(), 'ios', 'Podfile'),
    path.join(process.cwd(), 'apps', 'mobile', 'ios', 'Podfile'),
    path.join(process.cwd(), '..', 'ios', 'Podfile'),
    path.join(process.cwd(), '..', 'apps', 'mobile', 'ios', 'Podfile'),
  ];

  const targetPodfile = candidates.find((p) => fs.existsSync(p));
  if (!targetPodfile) {
    console.log('Podfile not found, skipping Podfile patch.');
    return;
  }

  let content = fs.readFileSync(targetPodfile, 'utf8');
  const block = `
post_install do |installer|
  installer.pods_project.targets.each do |target|
    next unless target.name == 'ExpoModulesJSI'

    target.build_configurations.each do |config|
      config.build_settings['SWIFT_VERSION'] = '5.9'
      config.build_settings['BUILD_LIBRARY_FOR_DISTRIBUTION'] = 'NO'
    end
  end
end
`;

  if (content.includes("target.name == 'ExpoModulesJSI'")) {
    console.log('Podfile already contains ExpoModulesJSI Swift override.');
    return;
  }

  if (content.includes('post_install do |installer|')) {
    content = content.replace(/post_install do \|installer\|\n(?:.*\n)*?end\n?/m, block);
  } else {
    content += `\n${block}\n`;
  }

  fs.writeFileSync(targetPodfile, content, 'utf8');
  console.log(`✓ Patched Podfile at ${targetPodfile}`);
}

const basePath = findExpoModulesJSI();
if (!basePath) {
  console.log('expo-modules-jsi not found, skipping patch.');
  patchPodfile();
  process.exit(0);
}

console.log(`Patching expo-modules-jsi at ${basePath} for Xcode 16 / Swift 6.1 compatibility...`);

// 1. Package.swift
const packageSwiftPath = path.join(basePath, 'apple/Package.swift');
if (fs.existsSync(packageSwiftPath)) {
  let content = fs.readFileSync(packageSwiftPath, 'utf8');
  content = content.replace(/swift-tools-version:\s*6\.2/g, 'swift-tools-version: 6.0');
  fs.writeFileSync(packageSwiftPath, 'utf8');
  console.log('✓ Patched Package.swift tools-version to 6.0');
}

// 2. Replace weak let with nonisolated(unsafe) weak var across all swift files
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
  if (!content.includes('static inline HostFunctionClosure *create')) {
    content = content.replace(
      'explicit HostFunctionClosure(Context context, Closure closure, Deallocator deallocator) : RetainedSwiftPointer(context, deallocator), _closure(closure) {};',
      `explicit HostFunctionClosure(Context context, Closure closure, Deallocator deallocator) : RetainedSwiftPointer(context, deallocator), _closure(closure) {};

  static inline HostFunctionClosure *create(Context context, Closure closure, Deallocator deallocator) {
    return new HostFunctionClosure(context, closure, deallocator);
  }`
    );
    fs.writeFileSync(hostFuncPath, content, 'utf8');
    console.log('✓ Added static create() to HostFunctionClosure.h');
  }
}

// 5. JavaScriptRuntime.swift
const jsRuntimePath = path.join(basePath, 'apple/Sources/ExpoModulesJSI/Runtime/JavaScriptRuntime.swift');
if (fs.existsSync(jsRuntimePath)) {
  let content = fs.readFileSync(jsRuntimePath, 'utf8');
  // Remove trailing comma in function signature
  content = content.replace(
    '_ arguments: consuming JavaScriptValuesBuffer,',
    '_ arguments: consuming JavaScriptValuesBuffer'
  );
  // Fix vector.push_back consuming: label
  content = content.replace(
    'vector.push_back(consuming: propNameId)',
    'vector.push_back(propNameId)'
  );
  // Use HostFunctionClosure.create instead of direct constructor
  content = content.replace(
    /return expo\.HostFunctionClosure\(context, call, deallocate\)/g,
    'return expo.HostFunctionClosure.create(context, call, deallocate)'
  );
  fs.writeFileSync(jsRuntimePath, content, 'utf8');
  console.log('✓ Patched JavaScriptRuntime.swift (vector push_back, HostFunctionClosure.create, trailing comma)');
}

patchPodfile();
console.log('expo-modules-jsi patching completed successfully.');
