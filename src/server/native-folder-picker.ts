import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);

const WINDOWS_FOLDER_DIALOG = `
using System;
using System.Runtime.InteropServices;
public static class OutmapperFolderDialog {
  [ComImport, Guid("DC1C5A9C-E88A-4DDE-A5A1-60F82A20AEF7")] private class FileOpenDialog {}
  [ComImport, Guid("42F85136-DB7E-439C-85F1-E4075D135FC8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  private interface IFileDialog {
    [PreserveSig] int Show(IntPtr parent);
    void SetFileTypes(); void SetFileTypeIndex(); void GetFileTypeIndex(); void Advise(); void Unadvise();
    void SetOptions(uint options); void GetOptions(out uint options);
    void SetDefaultFolder(); void SetFolder(); void GetFolder(); void GetCurrentSelection();
    void SetFileName(); void GetFileName(); void SetTitle(); void SetOkButtonLabel(); void SetFileNameLabel();
    void GetResult(out IShellItem item);
  }
  [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  private interface IShellItem {
    void BindToHandler(); void GetParent();
    void GetDisplayName(uint name, [MarshalAs(UnmanagedType.LPWStr)] out string path);
  }
  public static string Pick() {
    IFileDialog dialog = (IFileDialog)new FileOpenDialog();
    uint options;
    dialog.GetOptions(out options);
    dialog.SetOptions(options | 0x20 | 0x40);
    if (dialog.Show(IntPtr.Zero) != 0) return null;
    IShellItem item;
    dialog.GetResult(out item);
    string path;
    item.GetDisplayName(0x80058000, out path);
    return path;
  }
}`;

export const WINDOWS_FOLDER_PICKER_SCRIPT = [
  "$ProgressPreference = 'SilentlyContinue'",
  "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
  "$selected = $null",
  `try { Add-Type -TypeDefinition @'${WINDOWS_FOLDER_DIALOG}\n'@ -Language CSharp; $selected = [OutmapperFolderDialog]::Pick() }`,
  "catch { Add-Type -AssemblyName System.Windows.Forms; $picker = New-Object System.Windows.Forms.FolderBrowserDialog; $picker.ShowNewFolderButton = $true; if ($picker.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { $selected = $picker.SelectedPath }; $picker.Dispose() }",
  "if ($selected) { [Console]::Write($selected) }"
].join("\n");

export async function selectNativeFolder(): Promise<string | null> {
  if (process.platform === "win32") {
    const { stdout } = await execute("powershell.exe", ["-NoProfile", "-STA", "-EncodedCommand", Buffer.from(WINDOWS_FOLDER_PICKER_SCRIPT, "utf16le").toString("base64")], { windowsHide: true, maxBuffer: 64 * 1024 });
    return stdout.trim() || null;
  }
  try {
    const { stdout } = process.platform === "darwin"
      ? await execute("osascript", ["-e", "POSIX path of (choose folder)"])
      : await execute("zenity", ["--file-selection", "--directory"]);
    return stdout.trim() || null;
  } catch (error) {
    if ((error as { code?: unknown }).code === 1) return null;
    throw new Error("Native folder selection is unavailable on this system.", { cause: error });
  }
}
