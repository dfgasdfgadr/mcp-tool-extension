import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const HOST_NAME = 'com.aireq.mcp_helper';
const DEFAULT_EXTENSION_IDS = [
  'njgfblgbmbhkegiaopcpnikggdmieodc',
  'nemmokmbhlmcipjodfcdgckmmpjcofgp',
];
const extraIds = (process.env.AIREQ_EXTENSION_IDS || process.argv[2] || '')
  .split(/[,;\s]+/)
  .map(function (s) { return s.trim(); })
  .filter(Boolean);
const EXTENSION_IDS = Array.from(new Set(DEFAULT_EXTENSION_IDS.concat(extraIds)));
const EXTENSION_ID = EXTENSION_IDS[0];
const ALLOWED_ORIGINS = EXTENSION_IDS.map(function (id) {
  return 'chrome-extension://' + id + '/';
});
const serverPath = path.resolve(__dirname, 'server.mjs');
const nodePath = process.execPath;

const platform = os.platform();

function escapeCSharpString(str) {
  return String(str).replace(/"/g, '""');
}

function buildWindowsLauncherSource() {
  const escapedNodePath = escapeCSharpString(nodePath);
  const escapedServerPath = escapeCSharpString(serverPath);
  const escapedWorkingDir = escapeCSharpString(path.dirname(serverPath));
  return `using System;
using System.Diagnostics;
using System.Collections.Generic;

public static class Program {
  public static int Main(string[] args) {
    try {
      var psi = new ProcessStartInfo();
      psi.FileName = @"${escapedNodePath}";
      psi.WorkingDirectory = @"${escapedWorkingDir}";
      psi.UseShellExecute = false;
      psi.Arguments = JoinArgs(BuildArgs(args));
      using (var process = Process.Start(psi)) {
        process.WaitForExit();
        return process.ExitCode;
      }
    } catch (Exception ex) {
      Console.Error.WriteLine(ex.ToString());
      return 1;
    }
  }

  private static string[] BuildArgs(string[] args) {
    var list = new List<string>();
    list.Add(@"${escapedServerPath}");
    for (int i = 0; i < args.Length; i++) {
      list.Add(args[i]);
    }
    return list.ToArray();
  }

  private static string JoinArgs(string[] args) {
    var parts = new string[args.Length];
    for (int i = 0; i < args.Length; i++) {
      parts[i] = Quote(args[i]);
    }
    return string.Join(" ", parts);
  }

  private static string Quote(string arg) {
    if (string.IsNullOrEmpty(arg)) return "\\\"\\\"";
    if (arg.IndexOf(' ') < 0 && arg.IndexOf('\\t') < 0 && arg.IndexOf('\"') < 0) return arg;
    return "\\\"" + arg.Replace("\\\\", "\\\\\\\\").Replace("\\\"", "\\\\\\\"") + "\\\"";
  }
}`;
}

function installWindows() {
  const manifestDir = path.join(__dirname);
  const manifestPath = path.join(manifestDir, `${HOST_NAME}.json`);
  const launcherExePath = path.join(manifestDir, `${HOST_NAME}.exe`);
  const launcherSourcePath = path.join(manifestDir, `${HOST_NAME}.launcher.cs`);
  const launcherSource = buildWindowsLauncherSource();
  const manifest = {
    name: HOST_NAME,
    description: 'AI Request Analyzer MCP Helper',
    path: launcherExePath,
    type: 'stdio',
    allowed_origins: ALLOWED_ORIGINS.slice(),
  };
  const manifestJson = JSON.stringify(manifest, null, 2);

  fs.writeFileSync(launcherSourcePath, launcherSource, 'utf-8');
  console.log(`[安装] 已写入 launcher 源码: ${launcherSourcePath}`);
  try {
    execSync(
      `powershell -NoProfile -Command "Add-Type -Path '${launcherSourcePath.replace(/'/g, "''")}' -OutputAssembly '${launcherExePath.replace(/'/g, "''")}' -OutputType ConsoleApplication"`,
      { encoding: 'utf-8', stdio: 'pipe' }
    );
    console.log(`[安装] 已编译 launcher: ${launcherExePath}`);
  } catch (e) {
    console.error(`[错误] launcher 编译失败: ${e.message}`);
    process.exit(1);
  }
  fs.writeFileSync(manifestPath, manifestJson, 'utf-8');
  console.log(`[安装] 已写入 manifest: ${manifestPath}`);
  console.log(`[安装] allowed_origins: ${ALLOWED_ORIGINS.join(', ')}`);

  const regKey = `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}`;
  try {
    execSync(`reg add "${regKey}" /ve /t REG_SZ /d "${manifestPath}" /f`, {
      encoding: 'utf-8',
    });
    console.log(`[安装] 已注册注册表项: ${regKey}`);
  } catch (e) {
    console.error(`[错误] 注册表写入失败: ${e.message}`);
    process.exit(1);
  }
}

function installMac() {
  const targetDir = path.join(
    os.homedir(),
    'Library',
    'Application Support',
    'Google',
    'Chrome',
    'NativeMessagingHosts',
  );
  const targetPath = path.join(targetDir, `${HOST_NAME}.json`);
  const manifest = {
    name: HOST_NAME,
    description: 'AI Request Analyzer MCP Helper',
    path: serverPath,
    type: 'stdio',
    allowed_origins: ALLOWED_ORIGINS.slice(),
  };
  const manifestJson = JSON.stringify(manifest, null, 2);

  fs.mkdirSync(targetDir, { recursive: true });
  fs.writeFileSync(targetPath, manifestJson, 'utf-8');
  console.log(`[安装] 已写入 manifest: ${targetPath}`);
}

function installLinux() {
  const targetDir = path.join(
    os.homedir(),
    '.config',
    'google-chrome',
    'NativeMessagingHosts',
  );
  const targetPath = path.join(targetDir, `${HOST_NAME}.json`);
  const manifest = {
    name: HOST_NAME,
    description: 'AI Request Analyzer MCP Helper',
    path: serverPath,
    type: 'stdio',
    allowed_origins: ALLOWED_ORIGINS.slice(),
  };
  const manifestJson = JSON.stringify(manifest, null, 2);

  fs.mkdirSync(targetDir, { recursive: true });
  fs.writeFileSync(targetPath, manifestJson, 'utf-8');
  console.log(`[安装] 已写入 manifest: ${targetPath}`);
}

console.log(`[安装] 操作系统: ${platform}`);
console.log(`[安装] Node.js 路径: ${nodePath}`);
console.log(`[安装] Server 路径: ${serverPath}`);

switch (platform) {
  case 'win32':
    installWindows();
    break;
  case 'darwin':
    installMac();
    break;
  case 'linux':
    installLinux();
    break;
  default:
    console.error(`[错误] 不支持的操作系统: ${platform}`);
    process.exit(1);
}

console.log('[安装] ✅ Native Messaging Host 安装完成');
console.log('[安装] 请重启 Chrome 浏览器使配置生效');
