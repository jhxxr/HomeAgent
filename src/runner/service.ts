import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import type { RunnerConfig } from './config.js';
import { loadCredential } from './credentials.js';
const exec = promisify(execFile);
const xml = (value: string) => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]!);
export async function service(config: RunnerConfig, configFile: string, uninstall: boolean, log = console.log) {
  const cli = fileURLToPath(new URL('./cli.js', import.meta.url));
  if (!cli.endsWith('.js')) throw new Error('Build before installing a service');
  if (!uninstall) await loadCredential(config);
  const suffix = createHash('sha256').update(path.resolve(configFile)).digest('hex').slice(0, 8);
  if (process.platform === 'linux') {
    const name = `homeagent-${suffix}.service`, directory = path.join(os.homedir(), '.config/systemd/user'), unit = path.join(directory, name);
    const quote = (value: string) => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%')}"`;
    if (uninstall) {
      await exec('systemctl', ['--user', 'disable', '--now', name]);
      await unlink(unit); await exec('systemctl', ['--user', 'daemon-reload']);
    } else {
      await mkdir(directory, { recursive: true });
      await writeFile(unit, `[Unit]\nDescription=HomeAgent outbound runner\nAfter=network-online.target\n\n[Service]\nExecStart=${quote(process.execPath)} ${quote(cli)} run --plain --config ${quote(path.resolve(configFile))}\nRestart=on-failure\nRestartSec=5\nKillMode=control-group\nUMask=0077\nNoNewPrivileges=yes\n\n[Install]\nWantedBy=default.target\n`, { mode: 0o600 });
      await exec('systemctl', ['--user', 'daemon-reload']); await exec('systemctl', ['--user', 'enable', '--now', name]);
      log(`已安装 ${name}。如需退出登录后继续运行：sudo loginctl enable-linger ${os.userInfo().username}`);
    }
  } else if (process.platform === 'win32') {
    const name = `HomeAgent-${suffix}`;
    if (uninstall) {
      await exec('schtasks.exe', ['/End', '/TN', name], { windowsHide: true }).catch(() => {});
      await exec('schtasks.exe', ['/Delete', '/TN', name, '/F'], { windowsHide: true }); return;
    }
    const account = (await exec('whoami.exe', [], { windowsHide: true })).stdout.trim();
    const quote = (value: string) => `"${value.replace(/"/g, '')}"`;
    const task = `<?xml version="1.0" encoding="UTF-16"?><Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task"><Triggers><LogonTrigger><Enabled>true</Enabled><UserId>${xml(account)}</UserId></LogonTrigger></Triggers><Principals><Principal id="Author"><UserId>${xml(account)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals><Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><RestartOnFailure><Interval>PT1M</Interval><Count>3</Count></RestartOnFailure><Hidden>true</Hidden></Settings><Actions Context="Author"><Exec><Command>${xml(process.execPath)}</Command><Arguments>${xml(`${quote(cli)} run --plain --config ${quote(path.resolve(configFile))}`)}</Arguments><WorkingDirectory>${xml(path.dirname(configFile))}</WorkingDirectory></Exec></Actions></Task>`;
    const filename = path.join(config.stateDir, 'service.xml');
    await writeFile(filename, '\uFEFF' + task, 'utf16le');
    await exec('schtasks.exe', ['/Create', '/TN', name, '/XML', filename, '/F'], { windowsHide: true });
    await exec('schtasks.exe', ['/Run', '/TN', name], { windowsHide: true });
    log(`已安装登录启动任务 ${name}（低权限运行）。`);
  } else throw new Error('Service installation currently supports Linux and Windows');
}
