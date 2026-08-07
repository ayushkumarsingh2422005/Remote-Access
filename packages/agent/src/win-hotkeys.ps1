# SS Remote — Windows global hotkeys via RegisterHotKey
# Args: lockMods lockVk unlockMods unlockVk
param(
  [Parameter(Mandatory = $true)][int]$LockMods,
  [Parameter(Mandatory = $true)][int]$LockVk,
  [Parameter(Mandatory = $true)][int]$UnlockMods,
  [Parameter(Mandatory = $true)][int]$UnlockVk
)

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public struct MSG {
  public IntPtr hwnd;
  public uint message;
  public UIntPtr wParam;
  public IntPtr lParam;
  public uint time;
  public int pt_x;
  public int pt_y;
}

public static class SsHotKey {
  public const uint WM_HOTKEY = 0x0312;

  [DllImport("user32.dll", SetLastError = true)]
  public static extern bool RegisterHotKey(IntPtr hWnd, int id, uint fsModifiers, uint vk);

  [DllImport("user32.dll", SetLastError = true)]
  public static extern bool UnregisterHotKey(IntPtr hWnd, int id);

  [DllImport("user32.dll")]
  public static extern bool GetMessage(out MSG lpMsg, IntPtr hWnd, uint wMsgFilterMin, uint wMsgFilterMax);

  [DllImport("user32.dll")]
  public static extern bool TranslateMessage(ref MSG lpMsg);

  [DllImport("user32.dll")]
  public static extern IntPtr DispatchMessage(ref MSG lpMsg);
}
"@

$lockId = 1
$unlockId = 2

if (-not [SsHotKey]::RegisterHotKey([IntPtr]::Zero, $lockId, [uint32]$LockMods, [uint32]$LockVk)) {
  Write-Output "ERR: failed to register lock hotkey (maybe already in use)"
  exit 1
}
if (-not [SsHotKey]::RegisterHotKey([IntPtr]::Zero, $unlockId, [uint32]$UnlockMods, [uint32]$UnlockVk)) {
  [void][SsHotKey]::UnregisterHotKey([IntPtr]::Zero, $lockId)
  Write-Output "ERR: failed to register unlock hotkey (maybe already in use)"
  exit 1
}

Write-Output "READY"
[Console]::Out.Flush()

try {
  $msg = New-Object MSG
  while ([SsHotKey]::GetMessage([ref]$msg, [IntPtr]::Zero, 0, 0)) {
    if ($msg.message -eq [SsHotKey]::WM_HOTKEY) {
      if ($msg.wParam.ToUInt32() -eq $lockId) {
        Write-Output "LOCK"
        [Console]::Out.Flush()
      }
      elseif ($msg.wParam.ToUInt32() -eq $unlockId) {
        Write-Output "UNLOCK"
        [Console]::Out.Flush()
      }
    }
    [void][SsHotKey]::TranslateMessage([ref]$msg)
    [void][SsHotKey]::DispatchMessage([ref]$msg)
  }
}
finally {
  [void][SsHotKey]::UnregisterHotKey([IntPtr]::Zero, $lockId)
  [void][SsHotKey]::UnregisterHotKey([IntPtr]::Zero, $unlockId)
}
