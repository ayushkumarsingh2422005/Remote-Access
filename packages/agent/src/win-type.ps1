# Keyboard-only text injection via Win32 SendInput (no clipboard, no Tab key).
param(
  [Parameter(Mandatory = $true)][string]$TextFile,
  [int]$DelayMs = 0,
  [int]$TabWidth = 4
)

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class ArKeyboard {
  public const uint INPUT_KEYBOARD = 1;
  public const uint KEYEVENTF_KEYUP = 0x0002;
  public const uint KEYEVENTF_UNICODE = 0x0004;
  public const ushort VK_RETURN = 0x0D;

  [StructLayout(LayoutKind.Sequential)]
  public struct KEYBDINPUT {
    public ushort wVk;
    public ushort wScan;
    public uint dwFlags;
    public uint time;
    public IntPtr dwExtraInfo;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct MOUSEINPUT {
    public int dx;
    public int dy;
    public uint mouseData;
    public uint dwFlags;
    public uint time;
    public IntPtr dwExtraInfo;
  }

  [StructLayout(LayoutKind.Explicit)]
  public struct InputUnion {
    [FieldOffset(0)] public MOUSEINPUT mi;
    [FieldOffset(0)] public KEYBDINPUT ki;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct INPUT {
    public uint type;
    public InputUnion u;
  }

  [DllImport("user32.dll", SetLastError = true)]
  public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

  static int InputSize = Marshal.SizeOf(typeof(INPUT));

  public static void SendUnicode(char ch) {
    INPUT[] inputs = new INPUT[2];
    inputs[0].type = INPUT_KEYBOARD;
    inputs[0].u.ki.wVk = 0;
    inputs[0].u.ki.wScan = ch;
    inputs[0].u.ki.dwFlags = KEYEVENTF_UNICODE;
    inputs[1].type = INPUT_KEYBOARD;
    inputs[1].u.ki.wVk = 0;
    inputs[1].u.ki.wScan = ch;
    inputs[1].u.ki.dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP;
    uint sent = SendInput(2, inputs, InputSize);
    if (sent != 2) {
      throw new InvalidOperationException("SendInput unicode failed: " + Marshal.GetLastWin32Error());
    }
  }

  public static void TapVk(ushort vk) {
    INPUT[] inputs = new INPUT[2];
    inputs[0].type = INPUT_KEYBOARD;
    inputs[0].u.ki.wVk = vk;
    inputs[0].u.ki.dwFlags = 0;
    inputs[1].type = INPUT_KEYBOARD;
    inputs[1].u.ki.wVk = vk;
    inputs[1].u.ki.dwFlags = KEYEVENTF_KEYUP;
    uint sent = SendInput(2, inputs, InputSize);
    if (sent != 2) {
      throw new InvalidOperationException("SendInput vk failed: " + Marshal.GetLastWin32Error());
    }
  }
}
"@

$text = [System.IO.File]::ReadAllText($TextFile, [System.Text.Encoding]::UTF8)
# Never emit Tab — expand any leftover tabs to spaces
$spaces = ' ' * [Math]::Max(1, $TabWidth)
$text = $text.Replace([string][char]9, $spaces)

foreach ($ch in $text.ToCharArray()) {
  $code = [int][char]$ch
  if ($code -eq 13) { continue }

  if ($code -eq 10) {
    [ArKeyboard]::TapVk([ArKeyboard]::VK_RETURN)
  } elseif ($code -eq 9) {
    for ($i = 0; $i -lt $TabWidth; $i++) {
      [ArKeyboard]::SendUnicode([char]' ')
      if ($DelayMs -gt 0) {
        $jitter = Get-Random -Minimum 0 -Maximum ([Math]::Max(1, $DelayMs))
        Start-Sleep -Milliseconds ($DelayMs + $jitter)
      }
    }
    continue
  } else {
    [ArKeyboard]::SendUnicode($ch)
  }

  if ($DelayMs -gt 0) {
    $jitter = Get-Random -Minimum 0 -Maximum ([Math]::Max(1, $DelayMs))
    Start-Sleep -Milliseconds ($DelayMs + $jitter)
  }
}
