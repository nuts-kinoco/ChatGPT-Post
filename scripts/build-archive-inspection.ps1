param(
  [Parameter(Mandatory)][string]$NodeIncludeDirectory,
  [Parameter(Mandatory)][string]$NodeImportLibrary,
  [Parameter(Mandatory)][string]$MsvcDirectory,
  [Parameter(Mandatory)][string]$WindowsSdkDirectory,
  [Parameter(Mandatory)][string]$WindowsSdkVersion
)
$ErrorActionPreference = 'Stop'
if (-not [Environment]::Is64BitProcess -or $env:OS -ne 'Windows_NT') { throw 'Windows x64 build required' }
$repository = Split-Path -Parent $PSScriptRoot
$outputDirectory = Join-Path $repository 'dist/archive-inspection'
$compilerDirectory = Join-Path $MsvcDirectory 'bin/Hostx64/x64'
$compiler = Join-Path $compilerDirectory 'cl.exe'
$source = Join-Path $repository 'native/archive-inspection/inspection.cpp'
foreach ($required in @($compiler, $NodeImportLibrary, (Join-Path $NodeIncludeDirectory 'node_api.h'))) {
  if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw 'Missing existing build input' }
}
New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
$arguments = @('/nologo', '/std:c++17', '/EHsc', '/MD', '/LD', '/W4', '/WX',
  '/D_WIN32_WINNT=0x0A00', '/DNAPI_VERSION=8',
  "/I$NodeIncludeDirectory", "/I$(Join-Path $MsvcDirectory 'include')")
foreach ($include in @('ucrt', 'shared', 'um')) {
  $arguments += "/I$(Join-Path $WindowsSdkDirectory "Include/$WindowsSdkVersion/$include")"
}
$arguments += @("/Fo$(Join-Path $outputDirectory 'inspection.obj')", $source, '/link', '/INCREMENTAL:NO',
  "/LIBPATH:$(Join-Path $MsvcDirectory 'lib/x64')",
  "/LIBPATH:$(Join-Path $WindowsSdkDirectory "Lib/$WindowsSdkVersion/ucrt/x64")",
  "/LIBPATH:$(Join-Path $WindowsSdkDirectory "Lib/$WindowsSdkVersion/um/x64")",
  $NodeImportLibrary, 'Advapi32.lib', 'Kernel32.lib',
  "/IMPLIB:$(Join-Path $outputDirectory 'archive-inspection.lib')",
  "/OUT:$(Join-Path $outputDirectory 'archive-inspection.node')")
$previousPath = $env:PATH
try {
  $env:PATH = "$compilerDirectory;$previousPath"
  & $compiler @arguments
  if ($LASTEXITCODE -ne 0) { throw 'Archive observation build failed' }
} finally { $env:PATH = $previousPath }
Write-Output 'Built dist/archive-inspection/archive-inspection.node'
