param([switch]$Calibrate)
$ErrorActionPreference = 'Stop'
# Diagnostic branch only. Read attributes and lock owners; never release another process's locks.
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using FILETIME = System.Runtime.InteropServices.ComTypes.FILETIME;
public static class CleanupNative {
  [StructLayout(LayoutKind.Sequential)] public struct UniqueProcess { public uint Pid; public FILETIME Started; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct ProcessInfo {
    public UniqueProcess Process;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=256)] public string AppName;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=64)] public string ServiceName;
    public uint AppType; public uint AppStatus; public uint SessionId;
    [MarshalAs(UnmanagedType.Bool)] public bool Restartable;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern uint GetFileAttributesW(string path);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern IntPtr CreateFileW(string path, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool CloseHandle(IntPtr handle);
  [DllImport("rstrtmgr.dll", CharSet=CharSet.Unicode)] public static extern int RmStartSession(out uint session, uint flags, string key);
  [DllImport("rstrtmgr.dll", CharSet=CharSet.Unicode)] public static extern int RmRegisterResources(uint session, uint count, string[] paths, uint processCount, UniqueProcess[] processes, uint serviceCount, string[] services);
  [DllImport("rstrtmgr.dll")] public static extern int RmGetList(uint session, out uint needed, ref uint count, [In,Out] ProcessInfo[] infos, ref uint reason);
  [DllImport("rstrtmgr.dll")] public static extern int RmEndSession(uint session);
}
'@
function Inspect-Path([string]$Path) {
  $attributes = [CleanupNative]::GetFileAttributesW($Path)
  $attributeError = if ($attributes -eq [uint32]::MaxValue) { [Runtime.InteropServices.Marshal]::GetLastWin32Error() } else { 0 }
  # DELETE access, all sharing allowed, OPEN_EXISTING, BACKUP_SEMANTICS. No delete-on-close.
  $handle = [CleanupNative]::CreateFileW($Path, 0x10000, 7, [IntPtr]::Zero, 3, 0x02000000, [IntPtr]::Zero)
  $deleteAccessError = if ($handle -eq [IntPtr]::new(-1)) { [Runtime.InteropServices.Marshal]::GetLastWin32Error() } else { 0 }
  if ($handle -ne [IntPtr]::new(-1)) { [void][CleanupNative]::CloseHandle($handle) }
  # Restart Manager accepts file resources, not directory handles. Do not report an
  # empty owner list as proof that a directory has no owner.
  $ownerCoverage = if ($attributeError -ne 0) { 'unavailable-path' } elseif (($attributes -band 16) -ne 0) { 'unsupported-directory-handles' } else { 'file-resources-only' }
  [uint32]$session = 0
  $start = if ($ownerCoverage -eq 'file-resources-only') { [CleanupNative]::RmStartSession([ref]$session, 0, [Guid]::NewGuid().ToString('N')) } else { -1 }
  $register = $null; $list = $null; $owners = @()
  if ($start -eq 0) {
    try {
      $register = [CleanupNative]::RmRegisterResources($session, 1, [string[]]@($Path), 0, $null, 0, $null)
      if ($register -eq 0) {
        [uint32]$needed = 0; [uint32]$count = 0; [uint32]$reason = 0
        $list = [CleanupNative]::RmGetList($session, [ref]$needed, [ref]$count, $null, [ref]$reason)
        if ($list -eq 234) {
          $infos = [CleanupNative+ProcessInfo[]]::new($needed); $count = $needed
          $list = [CleanupNative]::RmGetList($session, [ref]$needed, [ref]$count, $infos, [ref]$reason)
          if ($list -eq 0) {
            $owners = @(for ($i=0; $i -lt $count; $i++) {
              $info = $infos[$i]
              $owner = Get-Process -Id $info.Process.Pid -ErrorAction SilentlyContinue
              @{ pid=$info.Process.Pid; name=$info.AppName; service=$info.ServiceName; executable=$owner.Path }
            })
          }
        }
      }
    } finally { [void][CleanupNative]::RmEndSession($session) }
  }
  @{ path=$Path; attributes=$attributes; attributeError=$attributeError; deleteAccessError=$deleteAccessError; restartManagerStart=$start; restartManagerRegister=$register; restartManagerList=$list; ownerCoverage=$ownerCoverage; owners=$owners }
}
if ($Calibrate) {
  $root = Join-Path ([IO.Path]::GetTempPath()) ('oc-cleanup-calibration-' + [Guid]::NewGuid().ToString('N'))
  [void][IO.Directory]::CreateDirectory($root)
  $locked = Join-Path $root 'locked.bin'; $readonly = Join-Path $root 'readonly.bin'
  [IO.File]::WriteAllText($locked, 'synthetic-lock'); [IO.File]::WriteAllText($readonly, 'synthetic-attribute')
  $stream = [IO.File]::Open($locked, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
  try {
    [IO.File]::SetAttributes($readonly, [IO.FileAttributes]::ReadOnly)
    $lockReceipt = Inspect-Path $locked; $attributeReceipt = Inspect-Path $readonly; $directoryReceipt = Inspect-Path $root
    @{ kind='calibration'; pid=$PID; locked=$lockReceipt; readonly=$attributeReceipt; directory=$directoryReceipt } | ConvertTo-Json -Depth 10 -Compress
    if ($lockReceipt.deleteAccessError -ne 32 -or $PID -notin @($lockReceipt.owners.pid) -or ($attributeReceipt.attributes -band 1) -ne 1 -or $directoryReceipt.ownerCoverage -ne 'unsupported-directory-handles') { throw 'Native lock/attribute diagnostic calibration failed.' }
  } finally {
    $stream.Dispose(); [IO.File]::SetAttributes($readonly, [IO.FileAttributes]::Normal); [IO.Directory]::Delete($root, $true)
  }
} else {
  $paths = @($env:OPENCLAW_CLEANUP_DIAGNOSTIC_PATHS | ConvertFrom-Json)
  $receipts = @($paths | ForEach-Object { Inspect-Path $_ })
  $root = $paths[0]
  $processes = @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($root, [StringComparison]::OrdinalIgnoreCase) } | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath)
  @{ kind='failure-observation'; observedAt=[DateTime]::UtcNow.ToString('o'); paths=$receipts; fixtureProcesses=$processes } | ConvertTo-Json -Depth 10 -Compress
}
